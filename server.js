import express from "express";
import cors from "cors";
import { ImageAnnotatorClient } from "@google-cloud/vision";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" })); // accept base64 images

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

app.get("/", (req, res) => {
  res.send("Face server up ✅");
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("listening on port", port);
});
