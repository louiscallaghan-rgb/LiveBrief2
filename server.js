const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== R2 CLIENT =====
const R2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME;

// ===== MULTER (memory buffer, then push to R2) =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files allowed'));
  }
});

// ===== UPLOAD ENDPOINT =====
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const key = `videos/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    await R2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      Metadata: { originalname: req.file.originalname }
    }));

    // Generate a signed URL valid for 7 days
    const url = await getSignedUrl(R2, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 604800 });

    res.json({ key, url, name: req.file.originalname, size: req.file.size });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== LIST STORED VIDEOS =====
app.get('/videos', async (req, res) => {
  try {
    const result = await R2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'videos/' }));
    const files = await Promise.all((result.Contents || []).map(async obj => {
      const url = await getSignedUrl(R2, new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }), { expiresIn: 604800 });
      const name = obj.Key.replace('videos/', '').replace(/^\d+-/, '');
      return { key: obj.Key, url, name, size: obj.Size, lastModified: obj.LastModified };
    }));
    res.json(files.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== DELETE VIDEO =====
app.delete('/videos/:key', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    await R2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ROOM STATE =====
let roomState = {
  queue: [], currentVideo: null, currentStartTime: null,
  chat: [], pins: [], users: {}
};

async function loadPersistedState() {
  const [{ data: messages }, { data: pins }] = await Promise.all([
    supabase.from('messages').select('*').order('created_at').limit(300),
    supabase.from('pins').select('*').order('created_at')
  ]);
  if (messages) roomState.chat = messages.map(m => ({ type: 'user', username: m.username, avatar: m.avatar, text: m.content, ts: new Date(m.created_at).getTime() }));
  if (pins) roomState.pins = pins.map(p => ({ id: p.id, seconds: p.time_seconds, note: p.note, author: p.username, avatar: p.avatar, videoId: p.video_key, ts: new Date(p.created_at).getTime() }));
}

loadPersistedState().catch(console.error);

function getVideoPosition() {
  if (!roomState.currentVideo || !roomState.currentStartTime) return 0;
  return (Date.now() - roomState.currentStartTime) / 1000;
}

function formatTime(s) {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}

function advanceQueue() {
  if (!roomState.queue.length) {
    roomState.currentVideo = null; roomState.currentStartTime = null;
    io.emit('video_ended'); return;
  }
  const next = roomState.queue.shift();
  roomState.currentVideo = next; roomState.currentStartTime = Date.now(); roomState.pins = [];
  io.emit('play_video', { video: next, position: 0, queue: roomState.queue, pins: [] });
}

// ===== SOCKETS =====
io.on('connection', (socket) => {

  socket.on('join', ({ username, avatar }) => {
    roomState.users[socket.id] = { id: socket.id, username, avatar };
    socket.emit('room_state', {
      users: Object.values(roomState.users), queue: roomState.queue,
      currentVideo: roomState.currentVideo, position: getVideoPosition(),
      chat: roomState.chat.slice(-80), pins: roomState.pins
    });
    io.emit('users_update', Object.values(roomState.users));
    io.emit('chat_message', { type: 'system', text: `${username} joined`, ts: Date.now() });
  });

  socket.on('chat', ({ text }) => {
    const user = roomState.users[socket.id];
    if (!user || !text.trim()) return;
    const msg = { type: 'user', username: user.username, avatar: user.avatar, text: text.trim().slice(0, 500), ts: Date.now() };
    roomState.chat.push(msg);
    if (roomState.chat.length > 300) roomState.chat.shift();
    io.emit('chat_message', msg);
    supabase.from('messages').insert({ username: user.username, avatar: user.avatar, content: msg.text }).catch(console.error);
  });

  socket.on('add_pin', ({ seconds, note }) => {
    const user = roomState.users[socket.id];
    if (!user || !roomState.currentVideo) return;
    const pin = {
      id: Date.now(), videoId: roomState.currentVideo.videoId || roomState.currentVideo.key,
      videoTitle: roomState.currentVideo.title, seconds: Math.floor(seconds),
      note: note.trim().slice(0, 500), author: user.username, avatar: user.avatar, ts: Date.now()
    };
    roomState.pins.push(pin);
    roomState.pins.sort((a, b) => a.seconds - b.seconds);
    io.emit('pin_added', pin);
    supabase.from('pins').insert({ username: user.username, avatar: user.avatar, time_seconds: pin.seconds, note: pin.note, video_key: pin.videoId }).catch(console.error);
    const msg = { type: 'pin', username: user.username, avatar: user.avatar, text: note.trim(), seconds: pin.seconds, label: formatTime(pin.seconds), pinId: pin.id, ts: Date.now() };
    roomState.chat.push(msg);
    io.emit('chat_message', msg);
  });

  socket.on('delete_pin', ({ id }) => {
    roomState.pins = roomState.pins.filter(p => p.id !== id);
    io.emit('pin_deleted', { id });
    supabase.from('pins').delete().eq('id', id).catch(console.error);
  });

  socket.on('pause', ({ seconds }) => {
    if (!roomState.currentVideo) return;
    roomState.isPaused = true;
    roomState.pausedAt = seconds;
    const user = roomState.users[socket.id];
    socket.broadcast.emit('remote_pause', { seconds, by: user?.username });
  });

  socket.on('play', ({ seconds }) => {
    if (!roomState.currentVideo) return;
    roomState.isPaused = false;
    roomState.pausedAt = 0;
    roomState.currentStartTime = Date.now() - seconds * 1000;
    const user = roomState.users[socket.id];
    socket.broadcast.emit('remote_play', { seconds, by: user?.username });
  });

  socket.on('seek_to', ({ seconds }) => {
    if (!roomState.currentVideo) return;
    roomState.currentStartTime = Date.now() - seconds * 1000;
    io.emit('seek', { seconds });
  });

  socket.on('add_to_queue', (item) => {
    const user = roomState.users[socket.id];
    if (!user) return;
    const entry = { ...item, addedBy: user.username, id: Date.now() };
    roomState.queue.push(entry);
    io.emit('queue_update', roomState.queue);
    io.emit('chat_message', { type: 'system', text: `${user.username} added "${item.title.slice(0,40)}"`, ts: Date.now() });
    if (!roomState.currentVideo) advanceQueue();
  });

  socket.on('video_ended', () => advanceQueue());

  socket.on('skip', () => {
    const user = roomState.users[socket.id];
    if (user) io.emit('chat_message', { type: 'system', text: `${user.username} skipped`, ts: Date.now() });
    advanceQueue();
  });

  socket.on('remove_from_queue', ({ id }) => {
    roomState.queue = roomState.queue.filter(v => v.id !== id);
    io.emit('queue_update', roomState.queue);
  });

  socket.on('play_now', ({ id }) => {
    const idx = roomState.queue.findIndex(v => v.id === id);
    if (idx === -1) return;
    const [item] = roomState.queue.splice(idx, 1);
    if (roomState.currentVideo) roomState.queue.unshift(roomState.currentVideo);
    roomState.currentVideo = item;
    roomState.currentStartTime = Date.now();
    roomState.pins = [];
    io.emit('play_video', { video: item, position: 0, queue: roomState.queue, pins: [] });
  });

  socket.on('disconnect', () => {
    const user = roomState.users[socket.id];
    if (user) {
      delete roomState.users[socket.id];
      io.emit('users_update', Object.values(roomState.users));
      io.emit('chat_message', { type: 'system', text: `${user.username} left`, ts: Date.now() });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Live Brief running on http://localhost:${PORT}`));
