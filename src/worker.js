import { inspectRecording, renderRecording } from './converter.js';
import { messagesFor, RecordingError } from './i18n.js';

self.onmessage = async ({ data }) => {
  const { action, video, metadata, info, options, language } = data;
  try {
    if (action === 'inspect') {
      self.postMessage({ type: 'verified', info: await inspectRecording(video, metadata, options) });
      return;
    }
    if (action === 'render') {
      let percentage = -1;
      const result = await renderRecording(video, metadata, info, { ...options, language }, progress => {
        const next = Math.min(99, Math.floor(progress * 100));
        if (next === percentage) return;
        percentage = next;
        self.postMessage({ type: 'progress', value: next / 100 });
      });
      self.postMessage({ type: 'finished', ...result });
    }
  } catch (error) {
    const messages = messagesFor(language);
    let message = messages.failedRead;
    if (error instanceof RecordingError) message = messages[error.key];
    else if (language !== 'es' && error instanceof Error) message = error.message;
    self.postMessage({ type: 'error', message });
  }
};
