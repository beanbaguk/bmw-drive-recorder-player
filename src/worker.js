import { inspectRecording, renderRecording } from './converter.js';

self.onmessage = async ({ data }) => {
  const { action, video, metadata, info, includeRoadMap } = data;
  try {
    if (action === 'inspect') {
      self.postMessage({ type: 'verified', info: await inspectRecording(video, metadata) });
      return;
    }
    if (action === 'render') {
      let percentage = -1;
      const result = await renderRecording(video, metadata, info, includeRoadMap, progress => {
        const next = Math.min(99, Math.floor(progress * 100));
        if (next === percentage) return;
        percentage = next;
        self.postMessage({ type: 'progress', value: next / 100 });
      });
      self.postMessage({ type: 'finished', ...result });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Something went wrong while reading the recording.' });
  }
};
