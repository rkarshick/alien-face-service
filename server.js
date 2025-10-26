import express from "express";
import cors from "cors";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { Storage } from "@google-cloud/storage";

const app = express();

// allow bigger body for base64 PDF uploads
app.use(cors());
app.use(express.json({ limit: "20mb" })); // bump for PDF

// --- FACE DETECTION SETUP ---
const visionClient = new ImageAnnotatorClient();

app.post("/detectFaces", async (req, res) => {
  try {
    if (!req.body || !req.body.imageBase64) {
      return res.status(400).json({ error: "No imageBase64 provided" });
    }

    const imageBase64 = req.body.imageBase64;

    const [result] = await visionClient.faceDetection({
      image: { content: imageBase64 },
    });

    const annotations = result.faceAnnotations || [];

    const faces = annotations
      .map((face) => {
        const verts = face.boundingPoly?.vertices || [];
        const xs = [];
        const ys = [];
        verts.forEach((v) => {
          if (typeof v.x === "number") xs.push(v.x);
          if (typeof v.y === "number") ys.push(v.y);
        });
        if (!xs.length || !ys.length) return null;
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        return {
          x: minX,
          y: minY,
          w: maxX - minX,
          h: maxY - minY,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.x - b.x);

    res.json({ faces });
  } catch (err) {
    console.error("detectFaces error:", err);
    res.status(500).json({ error: "Vision call failed" });
  }
});

// --- HEALTHCHECK / ROOT ---
app.get("/", (req, res) => {
  res.send("Face server up ✅");
});

// --- STORAGE SETUP ---
const storage = new Storage();
const BUCKET_NAME = "xcape-menu-bucket"; // your bucket
const OBJECT_NAME = "menu_current.pdf";  // always overwrite same name

// (we keep /getUploadUrl around, but we won't rely on it anymore)
app.post("/getUploadUrl", async (req, res) => {
  try {
    const contentType = req.body?.contentType || "application/pdf";

    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(OBJECT_NAME);

    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 5 * 60 * 1000,
      contentType: contentType,
    });

    res.status(200).json({ uploadUrl: signedUrl });
  } catch (err) {
    console.error("getUploadUrl error:", err);
    res.status(500).json({ error: "failed to sign URL" });
  }
});

// NEW: DIRECT UPLOAD ENDPOINT (no browser-to-GCS PUT, we do it here)
app.post("/uploadPdfDirect", async (req, res) => {
  try {
    // Expect: { pdfBase64: "AAAA...." }
    const pdfBase64 = req.body?.pdfBase64;
    if (!pdfBase64) {
      return res.status(400).json({ error: "No pdfBase64 provided" });
    }

    // Decode base64 to Buffer
    const pdfBuffer = Buffer.from(pdfBase64, "base64");

    // Write to GCS as menu_current.pdf
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(OBJECT_NAME);

    await file.save(pdfBuffer, {
      contentType: "application/pdf",
      resumable: false,
    });

    console.log("uploadPdfDirect: wrote", OBJECT_NAME, "(", pdfBuffer.length, "bytes )");

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("uploadPdfDirect error:", err);
    res.status(500).json({ error: "upload failed" });
  }
});

// SERVE LATEST MENU FOR PLAYERS
app.get("/menu_current", async (req, res) => {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(OBJECT_NAME);

    const [bytes] = await file.download();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(bytes);
  } catch (err) {
    console.error("menu_current error:", err);
    res.status(500).send("menu not available");
  }
});

// START SERVER
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("listening on port", port);
});
