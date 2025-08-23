// COMMAND TO START LOCAL TUNNEL: lt --port 4000 --subdomain tomato-slides

require("dotenv").config();
const express = require("express");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const bodyParser = require("body-parser");
const { v4: uuidv4 } = require("uuid");

const app = express();
let server;

if (process.env.NODE_ENV === "DEV") {
  server = http.createServer(app);
} else {
  options = {
    key: fs.readFileSync("/etc/letsencrypt/live/api.codekiwi.app/privkey.pem"),
    cert: fs.readFileSync(
      "/etc/letsencrypt/live/api.codekiwi.app/fullchain.pem"
    ),
    rejectUnauthorized: false,
  };

  server = https.createServer(options, app);
}

const wss = new WebSocket.Server({ server });

const PORT = process.env.NODE_ENV === "DEV" ? 4000 : 443;

const studentSessions = {}; // key: sessionCode, value: array of { id, name, code }
const sessionStatus = {};

// ------------------------ UTILITIES ------------------------

function parseNotesData(notesData) {
  // If it's already an array, return it processed
  if (Array.isArray(notesData)) {
    return notesData.map((note) =>
      typeof note === "string" ? note.trim() : ""
    );
  }

  // If it's not a string, convert to string first
  if (typeof notesData !== "string") {
    console.warn(
      "Notes data is not string or array, converting:",
      typeof notesData
    );
    notesData = String(notesData);
  }

  // Handle empty or whitespace-only strings
  if (!notesData || !notesData.trim()) {
    return [];
  }

  // Try to parse as JSON
  try {
    const parsed = JSON.parse(notesData);

    // If parsed result is an array, process it
    if (Array.isArray(parsed)) {
      return parsed.map((note) =>
        typeof note === "string" ? note.trim() : ""
      );
    }

    // If parsed result is not an array, wrap it in an array
    console.warn("Parsed notes data is not an array, wrapping:", parsed);
    return [String(parsed).trim()];
  } catch (jsonError) {
    // If JSON parsing fails, treat the entire string as a single note
    console.warn(
      "Failed to parse notes as JSON, treating as single note:",
      jsonError.message
    );
    return [notesData.trim()];
  }
}

// ------------------------ MIDDLEWARE ------------------------

// CORS for frontend
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://192.168.1.6:3000",
      "https://tomatocode.vercel.app",
      "https://codekiwi.app",
      "https://www.codekiwi.app",
    ],
    credentials: true,
  })
);

app.use(bodyParser.json({ limit: "10mb" }));
app.use("/slides", express.static(path.join(__dirname, "slides"))); // Serve slide images
const upload = multer({ dest: "uploads/" });

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

      if (data.type === "lock-editors") {
        const { sessionCode, locked } = data;
        console.log(
          `🔒 Editor lock toggle: ${locked} for session ${sessionCode}`
        );

        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: "lock-editors",
                sessionCode,
                locked,
              })
            );
          }
        });
      }

      if (data.type === "session-ended") {
        console.log(`🛑 Session ${data.sessionCode} ended by teacher`);

        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: "session-ended",
                sessionCode: data.sessionCode,
              })
            );
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

app.post("/api/sessions/upload", async (req, res) => {
  const { pdf } = await import("pdf-to-img");

  const { presentationId, title, notes, slidesUrl, fileBase64 } = req.body;

  if (!fileBase64 || !Array.isArray(notes) || !slidesUrl) {
    return res
      .status(400)
      .json({ success: false, message: "Missing fields in request body" });
  }

  const sessionId = Date.now().toString();
  sessionStatus[sessionId] = { active: true };
  const outputDir = path.join(__dirname, "slides", sessionId);

  try {
    fs.mkdirSync(outputDir, { recursive: true });

    const pdfBuffer = Buffer.from(fileBase64, "base64");
    const pdfPath = path.join(outputDir, `${sessionId}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    const document = await pdf(pdfPath, { scale: 3 });

    let counter = 1;
    for await (const image of document) {
      const filename = `slide-${counter}.png`;
      await fs.promises.writeFile(path.join(outputDir, filename), image);
      counter++;
    }

    fs.writeFileSync(
      path.join(outputDir, "notes.json"),
      JSON.stringify(notes, null, 2)
    );
    fs.writeFileSync(
      path.join(outputDir, "index.json"),
      JSON.stringify(
        {
          slides: fs
            .readdirSync(outputDir)
            .filter((f) => f.endsWith(".png"))
            .sort()
            .map((f) => `/slides/${sessionId}/${f}`),
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(outputDir, "meta.json"),
      JSON.stringify({ slidesUrl }, null, 2)
    );

    res.status(201).json({
      success: true,
      sessionCode: sessionId,
    });

    console.log(`✅ Session ${sessionId} created with ${counter - 1} slides`);
  } catch (err) {
    console.error("❌ Upload error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to process upload" });
  }
});

// ------------------------ CODE EXECUTION ------------------------

const LANG_CONFIG = {
  python: {
    extension: "py",
    image: "python:3.10",
    cmd: (filename) => `python -u ${filename}`,
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
  console.log("📩 Incoming /api/run request");

  if (!code || !language || !LANG_CONFIG[language]) {
    console.warn("❗ Invalid request - Missing code or language");
    return res.status(400).json({ error: "Invalid code or language" });
  }

  console.log("🧾 Code received:");
  console.log("-----BEGIN CODE-----");
  console.log(code);
  console.log("------END CODE------");
  console.log("🗣 Language:", language);

  const { extension, image, cmd } = LANG_CONFIG[language];
  const filename = `Main.${extension}`;
  const tempPath = path.join(__dirname, "temp");

  if (!fs.existsSync(tempPath)) {
    console.log("📂 Temp directory not found. Creating:", tempPath);
    fs.mkdirSync(tempPath);
  }

  const filePath = path.join(tempPath, filename);
  console.log("📝 Writing code to:", filePath);
  fs.writeFileSync(filePath, code, "utf8");

  const child = spawn("sudo", [
    "docker",
    "run",
    "--rm",
    "-v",
    `${tempPath}:/usr/src/app`,
    "-w",
    "/usr/src/app",
    "--memory=100m",
    "--cpus=0.5",
    image,
    "sh",
    "-c",
    cmd(filename),
  ]);

  let stdout = "";
  let stderr = "";
  let responded = false;

  const timer = setTimeout(() => {
    if (responded) return;
    responded = true;

    child.kill("SIGKILL");
    console.log("⛔ Execution killed due to timeout");
    return res.json({
      output: "⏰ Execution timed out (possible infinite loop)",
    });
  }, 10000);

  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  child.on("error", (err) => {
    if (responded) return;
    responded = true;

    clearTimeout(timer);
    console.error("❌ Spawn error:", err);
    res.json({ output: "Failed to run code: " + err.message });
  });

  child.on("close", (code) => {
    if (responded) return;
    responded = true;

    clearTimeout(timer);
    if (code !== 0) {
      console.log("❌ Process exited with code", code);
      return res.json({ output: stderr || "Unknown error" });
    }

    console.log("✅ Execution success:\n", stdout);
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
  const existing = studentSessions[sessionCode].find((s) => s.id === studentId);
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
  const student = students.find((s) => s.id === studentId);

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

  const status = sessionStatus[sessionCode];
  if (status && status.active === false) {
    return res.status(410).json({ error: "Session has ended" }); // 410 Gone
  }

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
  const notesPath = path.join(__dirname, "slides", sessionCode, "notes.json");

  if (!fs.existsSync(notesPath)) {
    return res.status(404).json({ error: "Notes not found" });
  }

  const notes = JSON.parse(fs.readFileSync(notesPath, "utf-8"));
  res.json({ notes });
});

app.get("/api/sessions/:sessionCode/coding-slides", (req, res) => {
  const { sessionCode } = req.params;
  const notesPath = path.join(__dirname, "slides", sessionCode, "notes.json");

  if (!fs.existsSync(notesPath)) {
    return res.status(404).json({ error: "Notes not found" });
  }

  const notes = JSON.parse(fs.readFileSync(notesPath, "utf-8"));

  // Get slide indices where the marker exists
  const codingSlides = notes.reduce((acc, note, index) => {
    if (typeof note === "string" && note.startsWith("Code Question:")) {
      acc.push(index);
    }
    return acc;
  }, []);

  res.json({ codingSlides }); // e.g. { codingSlides: [1, 3, 6] }
});

// ------------------------ CREATE SESSION ------------------------

app.get("/api/sessions/:sessionCode/exists", (req, res) => {
  const { sessionCode } = req.params;
  const sessionPath = path.join(__dirname, "slides", sessionCode);
  const exists = fs.existsSync(sessionPath);

  let active = sessionStatus[sessionCode]?.active;
  if (active === undefined) {
    // derive from meta.json if server restarted
    const metaPath = path.join(sessionPath, "meta.json");
    if (exists && fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        active = !meta.ended;
      } catch {
        active = true;
      }
    } else {
      active = exists; // if folder exists and no meta, treat as active
    }
  }

  res.json({ exists, active });
});

// ------------------------ END SESSION ------------------------

app.post("/api/sessions/:sessionCode/end", (req, res) => {
  const { sessionCode } = req.params;
  const sessionDir = path.join(__dirname, "slides", sessionCode);
  if (!fs.existsSync(sessionDir))
    return res.status(404).json({ error: "Session not found" });

  const endedAt = new Date().toISOString();
  sessionStatus[sessionCode] = { active: false, endedAt };

  const metaPath = path.join(sessionDir, "meta.json");
  let meta = {};
  try {
    if (fs.existsSync(metaPath))
      meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {}
  meta.ended = true;
  meta.endedAt = endedAt;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // notify live clients
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify({ type: "session-ended", sessionCode }));
    }
  });

  // optional: clear dashboard cache
  delete studentSessions[sessionCode];

  return res.json({ success: true });
});

// ------------------------ START SERVER ------------------------

server.listen(PORT, () => {
  console.log(`✅ Backend running at http://localhost:${PORT}`);
});
