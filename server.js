const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');


const app = express();

// CORS configuration to allow your frontend - needed for dev, not for production
app.use(cors({
  origin: ['http://localhost:3000', 'http://192.168.1.6:3000'],
  credentials: true
}));


// Serve converted slide images statically
app.use('/slides', express.static(path.join(__dirname, 'slides')));

const upload = multer({ dest: 'uploads/' });

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let currentSlide = 0;

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  ws.send(JSON.stringify({ type: 'sync', slide: currentSlide }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'change') {
        currentSlide = data.slide;
        console.log('Slide changed to:', currentSlide);

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'sync', slide: currentSlide }));
          }
        });
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// PDF upload route (posts to the backend)
app.post('/api/sessions/upload', upload.single('file'), async (req, res) => {
    const { pdf } = await import('pdf-to-img');
    console.log('✅ Received file:', req.file);
  
    const pdfPath = req.file.path;
    console.log('PDF path:', pdfPath);
    const sessionId = Date.now().toString();
    const outputDir = path.join(__dirname, 'slides', sessionId);
  
    fs.mkdirSync(outputDir, { recursive: true });
  
    console.log('➡️ Converting PDF to images using pdf-to-img...');
  
    try {
      const { pdf } = await import('pdf-to-img');
      const document = await pdf(pdfPath, {
        scale: 3, // Increase for better quality
      });
  
      let counter = 1;
      for await (const image of document) {
        const filename = `slide-${counter}.png`;
        const filepath = path.join(outputDir, filename);
        await fs.promises.writeFile(filepath, image);
        counter++;
      }
  
      fs.unlinkSync(pdfPath); // Delete uploaded PDF
      console.log('✅ PDF converted to images in:', outputDir);
  
      const imageFiles = fs.readdirSync(outputDir)
        .filter(file => file.endsWith('.png'))
        .sort();
  
      const imageUrls = imageFiles.map(filename => `/slides/${sessionId}/${filename}`);
      console.log('Here are the image URLs:', imageUrls);
  
      fs.writeFileSync(
        path.join(outputDir, 'index.json'),
        JSON.stringify({ slides: imageUrls }, null, 2)
      );
  
      console.log(`✅ Session ${sessionId} created with ${imageFiles.length} slides`);
  
      res.status(201).json({
        success: true,
        sessionCode: sessionId,
        slides: imageUrls,
      });
  
    } catch (err) {
      console.error('❌ Conversion failed:', err);
      res.status(500).json({ success: false, message: 'PDF conversion failed' });
    }
  });
  

// Health check endpoint (gets from the backend)
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, () => {
  console.log(`Slide-sync server running on http://localhost:${PORT}`);
  console.log(`Network access: http://192.168.1.6:${PORT}`);
});