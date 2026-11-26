// Where the grader's work is kept in the browser: IndexedDB (a batch of
// submissions with their PDF files is too large for localStorage).
//   meta      'session' -> { rubric, current }
//   students  key -> a student (see new_student in grading.js)
//   pdfs      key + '\0' + name -> Uint8Array (the PDF files of the students)
// Everything is also kept in memory when IndexedDB cannot be used (e.g. in a
// private window of some browsers): then it is gone after a reload.

const DB = 'logic-game-grading';
const STORES = ['meta', 'students', 'pdfs'];

function open_db() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      for (const s of STORES) if (!request.result.objectStoreNames.contains(s)) request.result.createObjectStore(s);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class GradingStore {
  constructor() {
    this.db = null;
    this.memory = Object.fromEntries(STORES.map((s) => [s, new Map()]));
    this.persistent = false;
  }

  async init() {
    try {
      this.db = await open_db();
      this.persistent = true;
    } catch {
      this.db = null;
    }
  }

  async op(store, mode, f) {
    if (!this.db) return f(null, this.memory[store]);
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode);
      const request = f(t.objectStore(store), null);
      t.oncomplete = () => resolve(request && 'result' in request ? request.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('the browser did not save it (is its storage full?)'));
    });
  }

  put(store, key, value) {
    return this.op(store, 'readwrite', (s, m) => (s ? s.put(value, key) : m.set(key, value)));
  }

  get(store, key) {
    return this.op(store, 'readonly', (s, m) => (s ? s.get(key) : m.get(key)));
  }

  all(store) {
    return this.op(store, 'readonly', (s, m) => (s ? s.getAll() : [...m.values()]));
  }

  async delete_where(store, test) {
    if (!this.db) {
      for (const k of [...this.memory[store].keys()]) if (test(k)) this.memory[store].delete(k);
      return;
    }
    const keys = await this.op(store, 'readonly', (s) => s.getAllKeys());
    await this.op(store, 'readwrite', (s) => {
      let last = null;
      for (const k of keys) if (test(k)) last = s.delete(k);
      return last;
    });
  }

  // { meta, students }
  async load() {
    const meta = (await this.get('meta', 'session')) || null;
    const students = (await this.all('students')) || [];
    return { meta, students };
  }

  save_meta(meta) {
    return this.put('meta', 'session', meta);
  }

  save_student(st) {
    // (the PDF files are kept apart)
    const { pdf_files, ...record } = st;
    return this.put('students', st.key, record);
  }

  async save_pdfs(key, files) {
    for (const f of files) await this.put('pdfs', key + '\0' + f.name, f.bytes);
  }

  pdf(key, name) {
    return this.get('pdfs', key + '\0' + name);
  }

  async forget_student(key) {
    await this.op('students', 'readwrite', (s, m) => (s ? s.delete(key) : m.delete(key)));
    await this.delete_where('pdfs', (k) => String(k).startsWith(key + '\0'));
  }

  async clear() {
    for (const store of STORES) {
      await this.op(store, 'readwrite', (s, m) => (s ? s.clear() : m.clear()));
    }
  }
}
