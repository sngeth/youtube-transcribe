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

// Transcribe route
app.post('/transcribe', upload.single('file'), async (req, res) => {
  try {
    console.log('Transcription request received');
    let audioPath;
    if (req.file) {
      audioPath = req.file.path;
      console.log(`File uploaded: ${audioPath}`);
    } else if (req.body.youtube_url) { // TODO: This is hanging on the video download
      const videoId = ytdl.getVideoID(req.body.youtube_url);
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

    if (!req.file) {
      console.log(`Deleting downloaded YouTube audio: ${audioPath}`);
      fs.unlinkSync(audioPath); // Delete the downloaded YouTube audio
    }

    console.log('Transcription complete');

    // Summarize the transcription
    console.log('Starting summarization');
    const summary = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a helpful assistant that summarizes text." },
        { role: "user", content: `Please summarize the following transcription:\n\n${transcription.text}` }
      ],
    });
    console.log('Summarization complete');

    console.log('Sending transcription and summary response');
    res.json({ 
      transcription: transcription.text,
      summary: summary.choices[0].message.content
    });
  } catch (error) {
    console.error('Transcription or summarization failed:', error);
    res.status(500).json({ error: 'Transcription or summarization failed', details: error.message });
  }
});

// Function to download audio from YouTube
async function downloadAudio(videoId, audioPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const info = await ytdl.getInfo(videoId);
      const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
      const stream = ytdl.downloadFromInfo(info, { format: audioFormats[0] })
        .pipe(fs.createWriteStream(audioPath));

      const timeout = setTimeout(() => {
        stream.destroy();
        reject(new Error('Download timed out'));
      }, 300000); // 5 minutes timeout

      stream.on('finish', () => {
        clearTimeout(timeout);
        console.log('YouTube audio download complete');
        resolve();
      });

      stream.on('error', (err) => {
        clearTimeout(timeout);
        console.error('Stream error:', err);
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// SSE route for progress updates
app.get('/transcribe-progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // flush the headers to establish SSE with the client
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
