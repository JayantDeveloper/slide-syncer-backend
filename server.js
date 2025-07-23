// COMMAND TO START LOCAL TUNNEL: lt --port 4000 --subdomain tomato-slides

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app); // Needed for WebSocket support
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 4000;

const studentSessions = {}; // key: sessionCode, value: array of { id, name, code }


// ------------------------ MIDDLEWARE ------------------------

// CORS for frontend
app.use(cors({
  origin: ["http://localhost:3000", "http://192.168.1.6:3000"],
  credentials: true,
}));

app.use(bodyParser.json()); // For code execution API
app.use('/slides', express.static(path.join(__dirname, 'slides'))); // Serve slide images
const upload = multer({ dest: 'uploads/' });

// ------------------------ SLIDE SYNC ------------------------

let currentSlide = 0;

wss.on("connection", (ws) => {
  console.log("🔌 New WebSocket connection");
  ws.send(JSON.stringify({ type: "sync", slide: currentSlide }));

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === "change") {
        currentSlide = data.slide;
        console.log("🎞 Slide changed to:", currentSlide);

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "sync", slide: currentSlide }));
          }
        });
      }
    } catch (error) {
      console.error("❌ Error parsing WebSocket message:", error);
    }
  });

  ws.on("close", () => console.log("❌ WebSocket connection closed"));
  ws.on("error", (err) => console.error("⚠️ WebSocket error:", err));
});

// ------------------------ PDF UPLOAD ------------------------

app.post('/api/sessions/upload', upload.single('file'), async (req, res) => {
  const { pdf } = await import('pdf-to-img');
  const pdfPath = req.file.path;
  const sessionId = Date.now().toString();
  const outputDir = path.join(__dirname, 'slides', sessionId);
  const notes = JSON.parse(req.body.notes || "[]").map(note =>
    typeof note === "string" ? note.trim() : ""
  );

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const document = await pdf(pdfPath, { scale: 3 });

    let counter = 1;
    for await (const image of document) {
      const filename = `slide-${counter}.png`;
      const filepath = path.join(outputDir, filename);
      await fs.promises.writeFile(filepath, image);
      counter++;
    }

    fs.writeFileSync(
      path.join(outputDir, 'notes.json'),
      JSON.stringify(notes, null, 2)
    );

    fs.unlinkSync(pdfPath); // Clean up original
    const imageFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.png')).sort();
    const imageUrls = imageFiles.map(f => `/slides/${sessionId}/${f}`);

    fs.writeFileSync(path.join(outputDir, 'index.json'), JSON.stringify({ slides: imageUrls }, null, 2));

    res.status(201).json({
      success: true,
      sessionCode: sessionId,
      slides: imageUrls,
    });

    console.log(`✅ Session ${sessionId} created with ${imageUrls.length} slides`);
  } catch (err) {
    console.error("❌ PDF conversion failed:", err);
    res.status(500).json({ success: false, message: "PDF conversion failed" });
  }
});

// ------------------------ CODE EXECUTION ------------------------

const LANG_CONFIG = {
  python: {
    extension: "py",
    image: "python:3.10",
    cmd: (filename) => `python ${filename}`,
  },
  javascript: {
    extension: "js",
    image: "node:20",
    cmd: (filename) => `node ${filename}`,
  },
  java: {
    extension: "java",
    image: "openjdk:17",
    cmd: (filename) => `javac ${filename} && java ${path.parse(filename).name}`,
  },
};

app.post("/api/run", async (req, res) => {
  const { code, language } = req.body;
  if (!code || !language || !LANG_CONFIG[language]) {
    return res.status(400).json({ error: "Invalid code or language" });
  }

  const { extension, image, cmd } = LANG_CONFIG[language];
  const filename = `Main.${extension}`;
  const tempPath = path.join(__dirname, "temp");

  if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath);
  const filePath = path.join(tempPath, filename);
  fs.writeFileSync(filePath, code);

  const dockerCmd = `
    docker run --rm \
      -v "${tempPath.replace(/ /g, '\\ ')}:/usr/src/app" \
      -w /usr/src/app \
      --memory="100m" --cpus="0.5" \
      ${image} sh -c "${cmd(filename)}"
  `;

  exec(dockerCmd, { timeout: 3000 }, (err, stdout, stderr) => {
    if (err) {
      if (err.killed) {
        // Docker process was killed due to timeout
        return res.json({ output: "⏰ Execution timed out (possible infinite loop)" });
      }
      return res.json({ output: stderr || err.message });
    }

    res.json({ output: stdout });
  });

});


// ------------------------ DASHBOARD UPDATES ------------------------

app.get("/api/sessions/:sessionCode/students", (req, res) => {
  const { sessionCode } = req.params;
  const students = studentSessions[sessionCode] || [];
  res.json({ students });
});

app.post("/api/sessions/:sessionCode/code", (req, res) => {
  const { sessionCode } = req.params;
  const { studentId, name, code, output } = req.body;

  if (!studentId || !name) {
    return res.status(400).json({ error: "Missing studentId or name" });
  }

  if (!studentSessions[sessionCode]) {
    studentSessions[sessionCode] = [];
  }

  // Update or insert the student's entry
  const existing = studentSessions[sessionCode].find(s => s.id === studentId);
  if (existing) {
    existing.code = code;
    existing.output = output; // ← reset output every time
  } else {
    studentSessions[sessionCode].push({ id: studentId, name, code, output });
  }

  res.json({ success: true });
});



// ------------------------ TEACHER INSPECT CODE VIEW ------------------------

app.get("/api/sessions/:sessionCode/students/:studentId", (req, res) => {
  const { sessionCode, studentId } = req.params;
  const students = studentSessions[sessionCode] || [];
  const student = students.find(s => s.id === studentId);

  if (!student) {
    return res.status(404).json({ error: "Student not found" });
  }

  res.json({
    name: student.name || "Unknown",
    code: student.code || "",
    output: student.output || "",
  });
});


// ------------------------ HEALTH CHECK ------------------------

app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ------------------------ STUDENT JOIN SESSION ------------------------

app.post("/api/sessions/:sessionCode/join", (req, res) => {
  const { sessionCode } = req.params;
  const { name } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Name is required" });
  }

  const studentId = uuidv4();

  if (!studentSessions[sessionCode]) {
    studentSessions[sessionCode] = [];
  }

  studentSessions[sessionCode].push({
    id: studentId,
    name: name.trim(),
    code: "",
    output: "",
  });

  res.json({ studentId });
});

// ------------------------ GET SLIDE NOTES ------------------------

app.get("/api/sessions/:sessionCode/notes", (req, res) => {
  const { sessionCode } = req.params;
  const notesPath = path.join(__dirname, 'slides', sessionCode, 'notes.json');

  if (!fs.existsSync(notesPath)) {
    return res.status(404).json({ error: "Notes not found" });
  }

  const notes = JSON.parse(fs.readFileSync(notesPath, "utf-8"));
  res.json({ notes });
});

// ------------------------ START SERVER ------------------------

server.listen(PORT, () => {
  console.log(`✅ Backend running at http://localhost:${PORT}`);
});
