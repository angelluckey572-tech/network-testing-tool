const express = require('express');
const path = require('path');
const http = require('http');
const net = require('net');
const dgram = require('dgram');

const app = express();
const port = Number(process.env.PORT) || 3000;

const state = {
  active: false,
  status: 'Idle',
  target: '',
  port: 80,
  method: 'tcp',
  duration: 60,
  packetCount: 0,
  startedAt: null,
  stopRequested: false,
  elapsedSeconds: 0,
  lastMessage: 'Ready to test',
  log: ['System ready. Use the controls to run a safe network diagnostic.'],
  workers: 0,
};

function addLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  state.log.push(`[${timestamp}] ${message}`);
  if (state.log.length > 60) {
    state.log.shift();
  }
  state.lastMessage = message;
}

function resetState() {
  state.active = false;
  state.status = 'Idle';
  state.packetCount = 0;
  state.startedAt = null;
  state.elapsedSeconds = 0;
  state.stopRequested = false;
  state.workers = 0;
}

function getTargetUrl(target, port, protocol = 'http') {
  const normalized = target.includes('://') ? target : `${protocol}://${target}`;
  return `${normalized}:${port}`;
}

function tcpProbe(target, port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connection timed out to ${target}:${port}`));
    }, 2000);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(`TCP connection established to ${target}:${port}`);
    });

    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    socket.connect(port, target);
  });
}

function udpProbe(target, port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const payload = Buffer.from('PING');

    const done = (err, message) => {
      if (settled) return;
      settled = true;
      socket.close();
      if (err) return reject(err);
      resolve(message);
    };

    socket.on('error', (error) => done(error, null));
    socket.send(payload, port, target, (error) => {
      if (error) return done(error, null);
      setTimeout(() => {
        done(null, `UDP datagram sent to ${target}:${port}`);
      }, 400);
    });
  });
}

async function httpProbe(target, port) {
  const url = getTargetUrl(target, port, 'http');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
    });
    return `HTTP probe received status ${response.status} from ${url}`;
  } finally {
    clearTimeout(timeout);
  }
}

function slowProbe(target, port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target,
      port,
      path: '/',
      method: 'GET',
      timeout: 3000,
    }, (response) => {
      response.on('data', () => {});
      response.on('end', () => {
        resolve(`Slow HTTP probe completed with status ${response.statusCode} on ${target}:${port}`);
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error(`Slow HTTP probe timed out for ${target}:${port}`));
    });

    request.on('error', reject);

    request.write('GET / HTTP/1.1\r\nHost: ' + target + '\r\nConnection: keep-alive\r\n');
    setTimeout(() => request.write('X-Trace: 1\r\n'), 250);
    setTimeout(() => request.write('X-Trace: 2\r\n'), 500);
    setTimeout(() => request.write('\r\n'), 800);
    request.end();
  });
}

async function runDiagnostic(payload) {
  const { target, port, method, duration } = payload;

  state.active = true;
  state.status = 'Running';
  state.target = target;
  state.port = port;
  state.method = method;
  state.duration = duration;
  state.startedAt = Date.now();
  state.stopRequested = false;
  state.workers = 1;
  addLog(`Starting ${method.toUpperCase()} diagnostic against ${target}:${port}`);

  const deadline = Date.now() + (duration * 1000);

  try {
    while (!state.stopRequested && Date.now() < deadline) {
      state.elapsedSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
      state.packetCount += 1;
      state.status = 'Running';

      try {
        let message = '';
        switch (method) {
          case 'udp':
            message = await udpProbe(target, port);
            break;
          case 'tcp':
            message = await tcpProbe(target, port);
            break;
          case 'http':
            message = await httpProbe(target, port);
            break;
          case 'slow':
            message = await slowProbe(target, port);
            break;
          default:
            message = `Unsupported method: ${method}`;
        }
        addLog(message);
      } catch (error) {
        addLog(`Diagnostic error: ${error.message}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (state.stopRequested) {
      state.status = 'Stopped';
      addLog('Diagnostic stopped by user request.');
    } else {
      state.status = 'Completed';
      addLog(`Diagnostic completed for ${target}:${port}.`);
    }
  } finally {
    resetState();
    state.lastMessage = state.status === 'Completed' ? 'Diagnostic completed.' : 'System ready';
    state.log.push(`Status: ${state.status}`);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  const elapsed = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  res.json({
    active: state.active,
    status: state.status,
    target: state.target,
    port: state.port,
    method: state.method,
    duration: state.duration,
    packetCount: state.packetCount,
    elapsedSeconds: elapsed,
    workers: state.workers,
    lastMessage: state.lastMessage,
    log: state.log.slice(-10),
  });
});

app.post('/api/start', (req, res) => {
  const { target, port, method, duration } = req.body || {};

  if (!target || !String(target).trim()) {
    return res.status(400).json({ ok: false, error: 'Target is required.' });
  }

  const parsedPort = Number(port) || 80;
  const selectedMethod = method || 'tcp';
  const selectedDuration = Number(duration) || 60;

  if (state.active) {
    return res.status(409).json({ ok: false, error: 'A diagnostic is already running.' });
  }

  const payload = {
    target: String(target).trim(),
    port: parsedPort,
    method: selectedMethod,
    duration: Math.min(Math.max(selectedDuration, 1), 3600),
  };

  state.active = true;
  state.status = 'Starting';
  state.lastMessage = 'Starting diagnostic';
  addLog(`Preparing ${selectedMethod.toUpperCase()} diagnostic on ${payload.target}:${payload.port}`);

  res.json({ ok: true, message: 'Diagnostic started.' });

  runDiagnostic(payload).catch((error) => {
    addLog(`Unhandled diagnostic exception: ${error.message}`);
    resetState();
  });
});

app.post('/api/stop', (req, res) => {
  if (!state.active) {
    return res.json({ ok: true, message: 'No active diagnostic to stop.' });
  }

  state.stopRequested = true;
  state.status = 'Stopping';
  state.lastMessage = 'Stop requested';
  addLog('Stop requested. Waiting for the current probe to finish.');
  res.json({ ok: true, message: 'Stop requested.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Network testing tool running on http://localhost:${port}`);
});
