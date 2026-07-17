/**
 * Everything audible in the habitat, synthesized from nothing.
 *
 * There are no audio files. Silk is a string under tension, so touching it is
 * Karplus-Strong synthesis: a burst of noise trapped in a feedback delay tuned
 * to the strand, darkening as it rings out — the same physics as a plucked
 * string, which is what a web strand is. The moth is amplitude-modulated air.
 * The room is a whisper of filtered noise, quiet enough to be doubted.
 *
 * Browsers refuse audio before a user gesture, so the context is created
 * lazily on the first interaction and everything degrades silently to nothing
 * when audio is unavailable.
 */
export class SilkAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private roomGain: GainNode | null = null;
  private flutterGain: GainNode | null = null;
  private flutterStopsAt = 0;
  private noiseBuffer: AudioBuffer | null = null;
  private enabledState: boolean;

  constructor(enabled: boolean) {
    this.enabledState = enabled;
  }

  get enabled(): boolean {
    return this.enabledState;
  }

  setEnabled(on: boolean): void {
    this.enabledState = on;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(on ? 1 : 0, this.context.currentTime, 0.08);
    }
    if (on) this.wake();
  }

  /** Call from any user gesture; safe to call every time. */
  wake(): void {
    if (!this.enabledState) return;
    if (!this.context) this.build();
    if (this.context?.state === "suspended") {
      void this.context.resume().catch(() => undefined);
    }
  }

  private build(): void {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const context = new Ctor();
    this.context = context;

    this.master = context.createGain();
    this.master.gain.value = this.enabledState ? 1 : 0;
    this.master.connect(context.destination);

    // Two seconds of white noise, reused for every voice that needs breath.
    const length = context.sampleRate * 2;
    this.noiseBuffer = context.createBuffer(1, length, context.sampleRate);
    const samples = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) samples[i] = Math.random() * 2 - 1;

    this.startRoomTone();
  }

  /** A nearly subliminal bed: dark filtered noise, slowly breathing. */
  private startRoomTone(): void {
    if (!this.context || !this.master || !this.noiseBuffer) return;
    const context = this.context;

    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;

    const lowpass = context.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 160;
    lowpass.Q.value = 0.4;

    this.roomGain = context.createGain();
    this.roomGain.gain.value = 0.012;

    // The room inhales and exhales over ~23 seconds — below notice, above absence.
    const breath = context.createOscillator();
    breath.frequency.value = 1 / 23;
    const breathDepth = context.createGain();
    breathDepth.gain.value = 0.005;
    breath.connect(breathDepth);
    breathDepth.connect(this.roomGain.gain);

    source.connect(lowpass);
    lowpass.connect(this.roomGain);
    this.roomGain.connect(this.master);
    source.start();
    breath.start();
  }

  /**
   * Plucks a silk string. Karplus-Strong: noise burst into a tuned feedback
   * delay with a darkening filter in the loop.
   */
  pluck(frequency: number, velocity = 1): void {
    this.wake();
    if (!this.context || !this.master || !this.noiseBuffer) return;
    const context = this.context;
    const now = context.currentTime;
    const hz = Math.min(1400, Math.max(70, frequency));

    const burst = context.createBufferSource();
    burst.buffer = this.noiseBuffer;

    const burstEnvelope = context.createGain();
    burstEnvelope.gain.setValueAtTime(0.55 * velocity, now);
    burstEnvelope.gain.exponentialRampToValueAtTime(0.001, now + 0.012);

    const loopDelay = context.createDelay(0.05);
    loopDelay.delayTime.value = 1 / hz;
    const feedback = context.createGain();
    feedback.gain.value = 0.945;
    const damper = context.createBiquadFilter();
    damper.type = "lowpass";
    damper.frequency.setValueAtTime(5200, now);
    damper.frequency.exponentialRampToValueAtTime(900, now + 1.6);

    const voice = context.createGain();
    voice.gain.setValueAtTime(0.5 * velocity, now);
    voice.gain.exponentialRampToValueAtTime(0.0005, now + 2.4);

    burst.connect(burstEnvelope);
    burstEnvelope.connect(loopDelay);
    loopDelay.connect(damper);
    damper.connect(feedback);
    feedback.connect(loopDelay);
    damper.connect(voice);
    voice.connect(this.master);

    burst.start(now, Math.random() * 1.5, 0.03);
    burst.stop(now + 0.05);
    window.setTimeout(() => {
      for (const node of [burstEnvelope, loopDelay, feedback, damper, voice]) node.disconnect();
    }, 2600);
  }

  /** Keeps the moth audible for `seconds`; call repeatedly while it struggles. */
  flutter(seconds = 1.2, intensity = 1): void {
    if (!this.enabledState || !this.context || !this.master || !this.noiseBuffer) return;
    const context = this.context;
    const now = context.currentTime;

    if (!this.flutterGain) {
      const source = context.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;

      const bandpass = context.createBiquadFilter();
      bandpass.type = "bandpass";
      bandpass.frequency.value = 340;
      bandpass.Q.value = 1.6;

      // Wingbeats: a fast tremolo carved into the noise.
      const wingbeat = context.createOscillator();
      wingbeat.frequency.value = 24;
      const wingDepth = context.createGain();
      wingDepth.gain.value = 0.5;

      this.flutterGain = context.createGain();
      this.flutterGain.gain.value = 0;

      const tremolo = context.createGain();
      wingbeat.connect(wingDepth);
      wingDepth.connect(tremolo.gain);
      tremolo.gain.value = 0.5;
      source.connect(bandpass);
      bandpass.connect(tremolo);
      tremolo.connect(this.flutterGain);
      this.flutterGain.connect(this.master);
      source.start();
      wingbeat.start();
    }

    const level = 0.05 * intensity;
    this.flutterGain.gain.cancelScheduledValues(now);
    this.flutterGain.gain.setTargetAtTime(level, now, 0.12);
    this.flutterStopsAt = Math.max(this.flutterStopsAt, now + seconds);
    this.flutterGain.gain.setTargetAtTime(0, this.flutterStopsAt, 0.3);
  }
}
