export interface SpectralBands {
  sub: number;
  body: number;
  mid: number;
  presence: number;
  air: number;
}

export interface PcmAnalysis {
  samplePeak: number;
  rms: number;
  rmsDbfs: number;
  lufsApprox: number;
  crestFactorDb: number;
  durationSeconds: number;
  dcOffset: number;
  spectralCentroidHz: number;
  energyBands: SpectralBands;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const decibels = (value: number): number =>
  value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY;

export function analyzePcm(
  channels: readonly Float32Array[],
  sampleRate: number,
): PcmAnalysis {
  if (channels.length === 0 || channels[0].length === 0) {
    throw new Error('PCM analysis requires at least one non-empty channel.');
  }

  const length = Math.min(...channels.map((channel) => channel.length));
  let peak = 0;
  let squareSum = 0;
  let sampleSum = 0;
  let sampleCount = 0;
  for (const channel of channels) {
    for (let i = 0; i < length; i++) {
      const sample = channel[i];
      peak = Math.max(peak, Math.abs(sample));
      squareSum += sample * sample;
      sampleSum += sample;
      sampleCount++;
    }
  }

  const meanSquare = squareSum / sampleCount;
  const rms = Math.sqrt(meanSquare);
  const mono = downmix(channels, length);
  const spectrum = analyzeSpectrum(mono, sampleRate);

  return {
    samplePeak: peak,
    rms,
    rmsDbfs: decibels(rms),
    lufsApprox: meanSquare > 0
      ? -0.691 + 10 * Math.log10(meanSquare)
      : Number.NEGATIVE_INFINITY,
    crestFactorDb: rms > 0 ? 20 * Math.log10(peak / rms) : 0,
    durationSeconds: length / sampleRate,
    dcOffset: sampleSum / sampleCount,
    spectralCentroidHz: spectrum.centroid,
    energyBands: spectrum.bands,
  };
}

export function channelRms(
  channel: Float32Array,
  startSample = 0,
  endSample = channel.length,
): number {
  const start = clamp(Math.floor(startSample), 0, channel.length);
  const end = clamp(Math.ceil(endSample), start, channel.length);
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += channel[i] * channel[i];
  return Math.sqrt(sum / (end - start));
}

export function canonicalizePcm16(
  channels: readonly Float32Array[],
  canonicalBits: number,
): Float32Array[] {
  validateCanonicalBits(canonicalBits);
  return channels.map((channel) => {
    const canonical = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const integer = quantizeSample16(channel[i], canonicalBits);
      canonical[i] = integer < 0 ? integer / 0x8000 : integer / 0x7fff;
    }
    return canonical;
  });
}

export function encodeWav16(
  channels: readonly Float32Array[],
  sampleRate: number,
  canonicalBits = 16,
): Uint8Array {
  if (channels.length === 0) throw new Error('WAV encoding requires PCM channels.');
  validateCanonicalBits(canonicalBits);
  const length = Math.min(...channels.map((channel) => channel.length));
  const bytesPerSample = 2;
  const dataLength = length * channels.length * bytesPerSample;
  const output = new Uint8Array(44 + dataLength);
  const view = new DataView(output.buffer);

  writeAscii(output, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(output, 8, 'WAVE');
  writeAscii(output, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * bytesPerSample, true);
  view.setUint16(32, channels.length * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(output, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let frame = 0; frame < length; frame++) {
    for (const channel of channels) {
      view.setInt16(
        offset,
        quantizeSample16(channel[frame], canonicalBits),
        true,
      );
      offset += bytesPerSample;
    }
  }
  return output;
}

function validateCanonicalBits(canonicalBits: number): void {
  if (!Number.isInteger(canonicalBits) || canonicalBits < 2 || canonicalBits > 16) {
    throw new Error('Canonical PCM precision must be an integer from 2 to 16 bits.');
  }
}

function quantizeSample16(sample: number, canonicalBits: number): number {
  const clamped = clamp(sample, -1, 1);
  const integer = clamped < 0
    ? Math.round(clamped * 0x8000)
    : Math.round(clamped * 0x7fff);
  const quantum = 2 ** (16 - canonicalBits);
  return clamp(
    Math.round(integer / quantum) * quantum,
    -0x8000,
    0x7fff,
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function downmix(
  channels: readonly Float32Array[],
  length: number,
): Float32Array {
  const mono = new Float32Array(length);
  const scale = 1 / channels.length;
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i] * scale;
  }
  return mono;
}

function analyzeSpectrum(
  samples: Float32Array,
  sampleRate: number,
): { centroid: number; bands: SpectralBands } {
  const fftSize = 4096;
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  let firstAudible = 0;
  let signalPeak = 0;
  for (let i = 0; i < samples.length; i++) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > signalPeak) signalPeak = magnitude;
  }
  const threshold = signalPeak * 0.01;
  while (firstAudible < samples.length && Math.abs(samples[firstAudible]) < threshold) {
    firstAudible++;
  }
  firstAudible = Math.max(0, firstAudible - 64);

  for (let i = 0; i < fftSize; i++) {
    const source = firstAudible + i < samples.length
      ? samples[firstAudible + i]
      : 0;
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1));
    real[i] = source * window;
  }
  fft(real, imaginary);

  const bandEnergy: SpectralBands = {
    sub: 0,
    body: 0,
    mid: 0,
    presence: 0,
    air: 0,
  };
  let weightedFrequency = 0;
  let totalEnergy = 0;
  for (let bin = 1; bin <= fftSize / 2; bin++) {
    const frequency = bin * sampleRate / fftSize;
    const energy = real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
    totalEnergy += energy;
    weightedFrequency += frequency * energy;
    if (frequency < 120) bandEnergy.sub += energy;
    else if (frequency < 500) bandEnergy.body += energy;
    else if (frequency < 2000) bandEnergy.mid += energy;
    else if (frequency < 8000) bandEnergy.presence += energy;
    else bandEnergy.air += energy;
  }

  if (totalEnergy > 0) {
    bandEnergy.sub /= totalEnergy;
    bandEnergy.body /= totalEnergy;
    bandEnergy.mid /= totalEnergy;
    bandEnergy.presence /= totalEnergy;
    bandEnergy.air /= totalEnergy;
  }
  return {
    centroid: totalEnergy > 0 ? weightedFrequency / totalEnergy : 0,
    bands: bandEnergy,
  };
}

function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const phaseReal = Math.cos(angle);
    const phaseImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += length) {
      let rotationReal = 1;
      let rotationImaginary = 0;
      for (let i = 0; i < length / 2; i++) {
        const even = offset + i;
        const odd = even + length / 2;
        const oddReal = real[odd] * rotationReal
          - imaginary[odd] * rotationImaginary;
        const oddImaginary = real[odd] * rotationImaginary
          + imaginary[odd] * rotationReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextRotationReal = rotationReal * phaseReal
          - rotationImaginary * phaseImaginary;
        rotationImaginary = rotationReal * phaseImaginary
          + rotationImaginary * phaseReal;
        rotationReal = nextRotationReal;
      }
    }
  }
}

function writeAscii(output: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) {
    output[offset + i] = value.charCodeAt(i);
  }
}
