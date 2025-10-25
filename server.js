import express from "express";
import cors from "cors";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { Storage } from "@google-cloud/storage"; // NEW import for GCS

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" })); // accept base64 images

// --- EXISTING FACE DETECTION SETUP (unchanged) ---
const client = new ImageAnnotatorClient();

app.post("/detectFaces", async (req, res) => {
  try {
    if (!req.body || !req.body.imageBase64) {
      return res.status(400).json({ error: "No imageBase64 provided" });
    }

    const imageBase64 = req.body.imageBase64;

    const [result] = await client.faceDetection({
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

// --- HEALTHCHECK / ROOT (unchanged) ---
app.get("/", (req, res) => {
  res.send("Face server up ✅");
});

// -------------------------------------------------
// NEW: Google Cloud Storage setup
// -------------------------------------------------
const storage = new Storage();

// CHANGE THIS to your actual bucket name from Cloud Storage
const BUCKET_NAME = "xcape-menu-bucket"; // <-- put your real bucket name here
const OBJECT_NAME = "menu_current.pdf";  // this stays constant

// -------------------------------------------------
// NEW ENDPOINT #1: /getUploadUrl
//
// The kiosk (index.html) calls this first.
// We generate a short-lived signed URL that lets the browser PUT the PDF
// directly into GCS at menu_current.pdf, even though the bucket is private.
//
// Request body JSON:
//   { "contentType": "application/pdf" }
//
// Response JSON:
//   { "uploadUrl": "https://storage.googleapis.com/....(signed stuff)..." }
//
// The browser then does: fetch(uploadUrl, {method:"PUT", headers:{"Content-Type":...}, body: pdfBlob})
// -------------------------------------------------
app.post("/getUploadUrl", async (req, res) => {
  try {
    const contentType = req.body?.contentType || "application/pdf";

    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(OBJECT_NAME);

    // Create a signed URL that allows a single WRITE (PUT)
    const [signedUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 5 * 60 * 1000, // 5 minutes from now
      contentType: contentType,
    });

    res.status(200).json({ uploadUrl: signedUrl });
  } catch (err) {
    console.error("getUploadUrl error:", err);
    res.status(500).json({ error: "failed to sign URL" });
  }
});

// -------------------------------------------------
// NEW ENDPOINT #2: /menu_current
//
// Players in the room will scan a QR code pointing here:
//
//   https://YOUR-CLOUD-RUN-URL/menu_current
//
// This endpoint will:
//   - Read the latest menu_current.pdf from the *private* bucket
//   - Stream it back as application/pdf
//
// This means you do NOT need public access on the bucket.
// You just need Cloud Run to be deployed with --allow-unauthenticated
// so guests' phones can GET this endpoint.
// -------------------------------------------------
app.get("/menu_current", async (req, res) => {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(OBJECT_NAME);

    // Download file bytes from GCS using the Cloud Run service account
    const [bytes] = await file.download();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store"); // always fetch fresh
    res.status(200).send(bytes);
  } catch (err) {
    console.error("menu_current error:", err);
    res.status(500).send("menu not available");
  }
});

// -------------------------------------------------
// START SERVER (unchanged except message)
// -------------------------------------------------
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("listening on port", port);
});
