// Sound: match cues and robot noise, all through Web Audio.
//
// Match cues play a recorded file when one exists in public/sounds/ (start.mp3, auto-end.mp3,
// teleop.mp3, shift.mp3, endgame.mp3, end.mp3; .wav or .ogg also work), and a built-in stand-in
// tone when it doesn't. The shooter (flywheel and shots) is
// synthesized live so it follows what the robot is doing. (No drive or wheel sound: abdur found it annoying.)

const CUES = ['start', 'auto-end', 'teleop', 'shift', 'endgame', 'end'];
const EXTS = ['mp3', 'wav', 'ogg'];

export class Sound {
  constructor() {
    this.ctx = null;
    this.files = {};
    this.volume = 0.8;
    this.robotOn = false;
  }

  /** Browsers only allow audio after a click or key press: call this from one. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    this.buildRobot();
    this.loadFiles();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  async loadFiles() {
    const base = `${import.meta.env.BASE_URL}sounds/`;
    for (const name of CUES) {
      for (const ext of EXTS) {
        try {
          const r = await fetch(`${base}${name}.${ext}`);
          if (!r.ok || (r.headers.get('content-type') || '').includes('text/html')) continue;
          this.files[name] = await this.ctx.decodeAudioData(await r.arrayBuffer());
          break;
        } catch { /* try the next one */ }
      }
    }
  }

  // ------------------------------------------------------------ match cues
  cue(name) {
    if (!this.ctx) return;
    const buf = this.files[name];
    if (buf) {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.connect(this.master);
      s.start();
      return;
    }
    // stand-ins until the real field sounds are added
    const t = this.ctx.currentTime;
    switch (name) {
      case 'start': // rising three-note fanfare
        [523, 659, 784].forEach((f, i) => this.tone(f, t + i * 0.16, i === 2 ? 0.6 : 0.14, 'sawtooth', 0.22));
        break;
      case 'auto-end':
      case 'end': // long field buzzer
        this.tone(110, t, name === 'end' ? 1.6 : 1.0, 'square', 0.25);
        this.tone(116, t, name === 'end' ? 1.6 : 1.0, 'square', 0.18);
        break;
      case 'teleop': // two bright bells
        this.tone(988, t, 0.35, 'triangle', 0.3);
        this.tone(1319, t + 0.18, 0.5, 'triangle', 0.3);
        break;
      case 'shift': // HUB switch chime
        this.tone(784, t, 0.25, 'sine', 0.35);
        this.tone(587, t + 0.2, 0.4, 'sine', 0.35);
        break;
      case 'endgame': // three horn blasts
        for (let i = 0; i < 3; i++) { this.tone(220, t + i * 0.32, 0.22, 'sawtooth', 0.22); this.tone(277, t + i * 0.32, 0.22, 'sawtooth', 0.16); }
        break;
      default:
    }
  }

  tone(freq, at, len, type, vol) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.015);
    g.gain.setValueAtTime(vol, at + Math.max(0.02, len - 0.08));
    g.gain.linearRampToValueAtTime(0, at + len);
    o.connect(g).connect(this.master);
    o.start(at);
    o.stop(at + len + 0.05);
  }

  // ------------------------------------------------------------ robot
  buildRobot() {
    const c = this.ctx;
    // shooter flywheel hum while spun up
    this.fly = c.createOscillator();
    this.fly.type = 'triangle';
    this.flyGain = c.createGain();
    this.flyGain.gain.value = 0;
    this.fly.connect(this.flyGain).connect(this.master);
    this.fly.start();
    // a short noise burst reused for every shot
    const n = c.sampleRate * 0.25;
    this.noise = c.createBuffer(1, n, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  }

  /** Every frame: speed (m/s), turn rate (rad/s), whether the shooter is spun up. */
  updateRobot(speed, omega, spinning, live) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = live ? 1 : 0;
    this.fly.frequency.setTargetAtTime(spinning ? 180 : 60, t, spinning ? 0.25 : 0.6);
    this.flyGain.gain.setTargetAtTime(k * (spinning ? 0.05 : 0), t, 0.2);
  }

  /** One FUEL leaving the shooter. */
  shot() {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900 + Math.random() * 300;
    f.Q.value = 0.8;
    const g = c.createGain();
    g.gain.value = 0.35;
    s.connect(f).connect(g).connect(this.master);
    s.start(t);
    // low thump of the ball hitting the flywheel
    const o = c.createOscillator();
    const og = c.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    og.gain.setValueAtTime(0.25, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.2);
  }
}
