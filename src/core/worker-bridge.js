// Promise wrapper around the workers. Each call gets an id so replies can be
// matched up, since a batch may have several jobs in flight at once.

const pending = new Map();
let nextJobId = 1;

function makeBridge(url) {
  let worker = null;

  function ensure() {
    if (worker) return worker;
    worker = new Worker(url, { type: 'module' });
    worker.onmessage = (event) => {
      const { id, ok, result, error } = event.data;
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      ok ? job.resolve(result) : job.reject(new Error(error));
    };
    worker.onerror = (event) => {
      // A worker-level failure leaves every in-flight job unanswered.
      for (const [id, job] of pending) {
        job.reject(new Error(event.message || 'Worker error'));
        pending.delete(id);
      }
    };
    return worker;
  }

  return function call(action, payload, transfer = []) {
    const id = nextJobId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ensure().postMessage({ id, action, payload }, transfer);
    });
  };
}

export const pdfCall = makeBridge(new URL('../workers/pdf.worker.js', import.meta.url));
