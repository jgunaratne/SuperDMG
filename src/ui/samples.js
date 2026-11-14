// Fetches and decodes the ElevenLabs multi-sampled studio instrument bank
// (`assets/instruments/manifest.json` + `.mp3` zones) into Float32 PCM buffers for
// `MidiSynth`. Uses `OfflineAudioContext` so decoding succeeds immediately on page load
// without waiting for a user-gesture unlock.

export async function loadElevenLabsInstrumentBank(midiSynth, baseUrl = 'assets/instruments') {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) return 0;

  const res = await fetch(`${baseUrl}/manifest.json`);
  if (!res.ok) return 0;
  const manifest = await res.json();
  if (!manifest || !Array.isArray(manifest.samples) || manifest.samples.length === 0) return 0;

  const decoder = new OfflineCtx(1, 1, 44100);
  const decoded = await Promise.all(
    manifest.samples.map(async (meta) => {
      try {
        const audioRes = await fetch(`${baseUrl}/${meta.file}`);
        if (!audioRes.ok) return null;
        const arrayBuf = await audioRes.arrayBuffer();
        const audioBuf = await decoder.decodeAudioData(arrayBuf);
        return {
          ...meta,
          sampleRate: audioBuf.sampleRate,
          pcm: audioBuf.getChannelData(0),
        };
      } catch {
        return null;
      }
    }),
  );

  const valid = decoded.filter(Boolean);
  return midiSynth.loadSampleBank(valid);
}
