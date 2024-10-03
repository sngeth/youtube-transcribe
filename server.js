const express = require('express');
const multer = require('multer');
const path = require('path');
const OpenAI = require("openai");
const ytdl = require('ytdl-core');
const fs = require('fs');
const app = express();

const upload = multer({ 
  dest: 'uploads/',
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
      cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname))
    }
  })
});

app.use(express.json());

// Configure OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Ensure uploads directory exists and is writable
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)){
    fs.mkdirSync(uploadsDir);
}
try {
    fs.accessSync(uploadsDir, fs.constants.W_OK);
    console.log('uploads directory is writable');
} catch (err) {
    console.error('uploads directory is not writable:', err);
    process.exit(1);
}

// Serve static files from the current directory
app.use(express.static(__dirname));

app.post('/transcribe', upload.single('file'), async (req, res) => {
  try {
    sendProgressUpdate(25); // Send 50% progress before starting transcription
    console.log('Transcription request received');
    let audioPath;
    let trimmedAudioPath;
    if (req.file) {
      audioPath = req.file.path;
      console.log(`File uploaded: ${audioPath}`);
      
      audioPath = req.file.path;
    } else if (req.body.youtube_url) {
      const videoId = ytdl.getVideoID(req.body.youtube_url);
      audioPath = path.join(uploadsDir, `${videoId}.mp3`);
      await downloadAudio(videoId, audioPath);
      
      audioPath = path.join(uploadsDir, `${videoId}.mp3`);
      await downloadAudio(videoId, audioPath);
    } else {
      console.log('Error: No file uploaded or YouTube URL provided');
      return res.status(400).json({ error: 'No file uploaded or YouTube URL provided' });
    }

    console.log('Starting transcription');
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
    });
    console.log('Transcription complete');
    sendProgressUpdate(75); // Send 75% progress after transcription is complete
    if (!req.file) {
      console.log(`Deleting downloaded YouTube audio: ${audioPath}`);
      fs.unlinkSync(audioPath); // Delete the downloaded YouTube audio
    }

    console.log('Transcription complete');

    // Summarize the transcription
    console.log('Starting summarization');
    sendProgressUpdate(80); // Send 80% progress before starting summarization
    const summary = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a helpful assistant that summarizes text." },
        { role: "user", content: `Please summarize the following transcription:\n\n${transcription.text}` }
      ],
    });
    console.log('Summarization complete');
    sendProgressUpdate(95); // Send 95% progress after summarization is complete
    console.log('Sending transcription and summary response');
    sendProgressUpdate(100); // Send 100% progress before sending the final response
    res.json({ 
      transcription: transcription.text,
      summary: summary.choices[0].message.content
    });
  } catch (error) {
    console.error('Transcription or summarization failed:', error);
    let errorMessage = 'Transcription or summarization failed';
    let statusCode = 500;

    if (error.status === 413 && error.error && error.error.message) {
      errorMessage = `The audio file is too large. ${error.error.message}`;
      statusCode = 413;
    } else if (error.message) {
      errorMessage += ': ' + error.message;
    }

    console.log('Sending error response:', { error: errorMessage, status: statusCode });
    res.status(statusCode).json({ error: errorMessage, status: statusCode });
  }
});

// Function to download audio from YouTube
async function downloadAudio(videoId, audioPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Check if the file already exists
      if (fs.existsSync(audioPath)) {
        console.log('Audio file already exists, using cached version');
        return resolve();
      }

      const info = await ytdl.getInfo(videoId);
      const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
      const stream = ytdl.downloadFromInfo(info, { format: audioFormats[0] });
      
      let downloadedBytes = 0;
      const maxBytes = 26214400; // 25 MB (OpenAI's limit)
      
      const writeStream = fs.createWriteStream(audioPath);

      stream.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (downloadedBytes > maxBytes) {
          stream.destroy();
          writeStream.end();
          console.log(`Download capped at ${maxBytes} bytes`);
          sendProgressUpdate(100); // Send 100% progress when download is complete
          resolve(); // Resolve the promise here to continue processing
        } else {
          const progress = Math.min(100, Math.round((downloadedBytes / maxBytes) * 100));
          sendProgressUpdate(progress);
        }
      });

      stream.pipe(writeStream);

      const timeout = setTimeout(() => {
        stream.destroy();
        writeStream.end();
        reject(new Error('Download timed out'));
      }, 300000); // 5 minutes timeout

      writeStream.on('finish', () => {
        clearTimeout(timeout);
        console.log('YouTube audio download complete');
        resolve();
      });

      writeStream.on('error', (err) => {
        clearTimeout(timeout);
        console.error('Stream error:', err);
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Function to check if audio file is within size limit
function checkAudioSize(filePath, maxSizeBytes = 25 * 1024 * 1024) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxSizeBytes) {
    throw new Error(`Audio file size exceeds the limit of ${maxSizeBytes / (1024 * 1024)} MB`);
  }
}

const WebSocket = require('ws');
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  ws.on('message', (message) => {
    console.log('Received message:', message);
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

// Function to send progress updates
function sendProgressUpdate(progress) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'progress', value: progress }));
    }
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
