const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const storageModule = require('../director-storage.js');
const model = require('../director-project.js');
const baseline = require('../scenes.js');
const project = () => model.fromStory(baseline);
const turn = () => new Promise(resolve => setImmediate(resolve));

// A small transaction driver: requests succeed before commit, while an abort
// discards all writes. Real IndexedDB is also checked by the browser scenarios.
function indexedDBHarness() {
  const state = { data:new Map(), stores:new Map(), opens:[], databases:[], closed:0,
    blockOpen:false, failOpen:null, failRequest:null, failCommit:null, holdComplete:false, held:[] };
  function database() {
    const db = {
      closed:false,
      objectStoreNames:{ contains:name => state.stores.has(name) },
      createObjectStore(name, options) {
        state.stores.set(name, options.keyPath);
        state.data.set(name, new Map());
      },
      close() { db.closed = true; state.closed++; },
      transaction(names, mode) {
        if (db.closed) throw new DOMException('Closed', 'InvalidStateError');
        const requested = Array.isArray(names) ? names : [names];
        const snapshots = new Map(requested.map(name => [name, new Map([...state.data.get(name)].map(([key,value]) => [key,structuredClone(value)]))]));
        let active = true, pending = 0, scheduled = false;
        const tx = { error:null, oncomplete:null, onabort:null, onerror:null,
          abort() {
            if (!active) throw new DOMException('Inactive', 'InvalidStateError');
            active = false;
            queueMicrotask(() => tx.onabort?.({target:tx}));
          },
          objectStore(name) {
            if (!snapshots.has(name)) throw new Error('Store outside transaction');
            const data = snapshots.get(name), keyPath = state.stores.get(name);
            const request = action => {
              if (!active) throw new DOMException('Inactive', 'TransactionInactiveError');
              const result = { result:undefined, error:null, onsuccess:null, onerror:null };
              pending++;
              queueMicrotask(() => {
                if (!active) return;
                try {
                  if (state.failRequest) { const error=state.failRequest; state.failRequest=null; throw error; }
                  result.result = action();
                  result.onsuccess?.({target:result});
                } catch (error) {
                  result.error = error; tx.error = error;
                  result.onerror?.({target:result}); tx.onerror?.({target:tx});
                  if (active) tx.abort();
                } finally { pending--; schedule(); }
              });
              return result;
            };
            return {
              get(key) { return request(() => structuredClone(data.get(key))); },
              getAll() { return request(() => [...data.values()].map(value => structuredClone(value))); },
              put(value) { return request(() => { if(mode!=='readwrite')throw new Error('Readonly write'); data.set(value[keyPath],structuredClone(value)); return value[keyPath]; }); },
              add(value) { return request(() => { if(mode!=='readwrite')throw new Error('Readonly write'); if(data.has(value[keyPath]))throw new DOMException('Duplicate','ConstraintError'); data.set(value[keyPath],structuredClone(value)); return value[keyPath]; }); },
              delete(key) { return request(() => { if(mode!=='readwrite')throw new Error('Readonly write'); data.delete(key); }); }
            };
          }
        };
        function complete() {
          if (!active) return;
          if (pending) { schedule(); return; }
          if (state.failCommit) {
            tx.error = state.failCommit; state.failCommit = null; tx.abort(); return;
          }
          if (mode === 'readwrite') for (const name of requested) state.data.set(name, snapshots.get(name));
          active = false;
          tx.oncomplete?.({target:tx});
        }
        function schedule() {
          if (!active || pending || scheduled) return;
          scheduled = true;
          setImmediate(() => {
            scheduled = false;
            if (!active || pending) return;
            if (state.holdComplete) state.held.push(complete);
            else complete();
          });
        }
        schedule();
        return tx;
      }
    };
    state.databases.push(db);
    return db;
  }
  const indexedDB = {
    open(name, version) {
      const request = { result:null, error:null, onupgradeneeded:null, onblocked:null, onerror:null, onsuccess:null };
      state.opens.push({name,version,request});
      queueMicrotask(() => {
        if (state.failOpen) {
          request.error = state.failOpen; state.failOpen = null; request.onerror?.({target:request}); return;
        }
        if (state.blockOpen) { request.onblocked?.({target:request}); return; }
        request.result = database();
        if (!state.stores.size) request.onupgradeneeded?.({target:request});
        request.onsuccess?.({target:request});
      });
      return request;
    }
  };
  return { indexedDB, state,
    release() { state.holdComplete=false; for (const complete of state.held.splice(0)) complete(); },
    lateSuccess(request) { request.result=database(); request.onsuccess?.({target:request}); }
  };
}

function file(id='voice-one', contents=[1,2,3]) {
  const blob = new Blob([Uint8Array.from(contents)], {type:'audio/wav'});
  return { id, blob, metadata:{id,name:'Запись.wav',type:'audio/wav',size:blob.size,durationMs:2000} };
}

test('browser/CommonJS exports use a separate director database and never old application keys', async () => {
  const sandbox = {window:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../director-storage.js'),'utf8'),sandbox);
  assert.equal(typeof sandbox.window.AlleyDirectorStorage.create,'function');
  const h=indexedDBHarness();
  const options={indexedDB:h.indexedDB};
  Object.defineProperty(options,'localStorage',{get(){throw new Error('Old storage must not be read');}});
  const storage=storageModule.create(options);
  assert.equal(await storage.load(),null);
  assert.equal(h.state.opens.length,1);
  assert.equal(h.state.opens[0].name,'alley-director-v1');
  assert.equal(h.state.opens[0].version,1);
  assert.deepEqual([...h.state.stores.keys()],['projects','media']);
});

test('save waits for transaction commit and roundtrips defensive project copies', async () => {
  const h=indexedDBHarness(), storage=storageModule.create({indexedDB:h.indexedDB});
  await storage.load();
  h.state.holdComplete=true;
  const input=project(), pending=storage.save(input);
  input.title='Изменённый внешний объект';
  let done=false; pending.then(()=>{done=true;});
  await turn(); await turn();
  assert.equal(done,false,'request success alone must not report a saved project');
  assert.equal(h.state.data.get('projects').has('current'),false);
  h.release();
  const saved=await pending;
  assert.equal(saved.title,'Переулок');
  saved.title='Другая внешняя копия';
  const loaded=await storage.load();
  assert.equal(loaded.title,'Переулок');
  loaded.scenes.reverse();
  assert.equal((await storage.load()).scenes[0].id,'alley');
});

test('a late quota abort rejects save and retains the previously committed project', async () => {
  const h=indexedDBHarness(), storage=storageModule.create({indexedDB:h.indexedDB});
  const first=project(); await storage.save(first);
  const second=project(); second.title='Не должно сохраниться';
  h.state.failCommit=new DOMException('Quota','QuotaExceededError');
  await assert.rejects(storage.save(second),/недостаточно места/);
  assert.deepEqual(await storage.load(),first);
  await storage.save(second);
  assert.equal((await storage.load()).title,second.title);
});

test('request failures abort without false save success or loss of earlier state', async () => {
  const h=indexedDBHarness(), storage=storageModule.create({indexedDB:h.indexedDB});
  await storage.save(project());
  h.state.failRequest=new DOMException('Quota','QuotaExceededError');
  await assert.rejects(storage.save({...project(),title:'Вторая'}),/недостаточно места/);
  assert.equal((await storage.load()).title,'Переулок');
});

test('project metadata and immutable audio blobs are stored separately and retrieved intact', async () => {
  const h=indexedDBHarness(), storage=storageModule.create({indexedDB:h.indexedDB}), item=file();
  const description=await storage.putMedia(item);
  description.name='Внешняя замена.wav';
  const current=project(); current.media.push(item.metadata);
  current.scenes[0].tracks.push({id:'track-one',kind:'voice',assetId:item.id,startMs:0,volume:.7,loop:false});
  await storage.save(current);
  const blob=await storage.getMedia(item.id);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())],[1,2,3]);
  assert.equal(blob.type,'audio/wav');
  assert.equal((await storage.listMedia())[0].name,'Запись.wav');
  const loaded=await storage.load();
  assert.equal(loaded.media[0].size,3);
  assert.equal(Object.hasOwn(loaded.media[0],'blob'),false);
  assert.equal(await storage.getMedia('missing'),null);
  assert.equal(await storage.getMedia('../invalid'),null);
});

test('an existing media id cannot be overwritten even when new bytes have the same size', async () => {
  const h=indexedDBHarness(), storage=storageModule.create({indexedDB:h.indexedDB});
  await storage.putMedia(file());
  await assert.rejects(storage.putMedia(file('voice-one',[9,8,7])),/уже сохранён/);
  assert.deepEqual([...new Uint8Array(await (await storage.getMedia('voice-one')).arrayBuffer())],[1,2,3]);
  assert.equal((await storage.listMedia()).length,1);
  await storage.putMedia(file('replacement',[9,8,7]));
  assert.equal((await storage.listMedia()).length,2,'new recording uses a distinct id');
});

test('media deletion protects saved scene references and permits explicit unreferenced removal', async () => {
  const h=indexedDBHarness(), storage=storageModule.create({indexedDB:h.indexedDB}), item=file();
  await storage.putMedia(item);
  const saved=project(); saved.media.push(item.metadata);
  saved.scenes[4].tracks.push({id:'layer',kind:'voice',assetId:item.id,startMs:0,volume:1,loop:false});
  await storage.save(saved);
  await assert.rejects(storage.deleteMedia(item.id),/используется сохранённым проектом/);
  assert.ok(await storage.getMedia(item.id));
  saved.scenes[4].tracks=[]; await storage.save(saved);
  await storage.deleteMedia(item.id);
  assert.equal(await storage.getMedia(item.id),null);
  assert.deepEqual(await storage.listMedia(),[]);
  await assert.rejects(storage.deleteMedia('../invalid'),/Недопустимый/);
});

test('unavailable or blocked storage is explicit and transient open errors can be retried', async () => {
  const unavailable=storageModule.create({indexedDB:null});
  await assert.rejects(unavailable.load(),/хранилище недоступно/);
  await assert.rejects(unavailable.save(project()),/Сохранение не выполнено/);
  const denied=storageModule.create({indexedDB:{open(){throw new DOMException('Denied','SecurityError');}}});
  await assert.rejects(denied.load(),/запретил локальное хранилище/);
  const h=indexedDBHarness(), storage=storageModule.create({indexedDB:h.indexedDB});
  h.state.failOpen=new DOMException('Denied','SecurityError');
  await assert.rejects(storage.load(),/запретил локальное хранилище/);
  assert.equal(await storage.load(),null);
  assert.equal(h.state.opens.length,2);
});

test('a denied indexedDB getter leaves the controller usable and reports failed persistence asynchronously', async () => {
  const window = {};
  let reads = 0;
  Object.defineProperty(window, 'indexedDB', { get() {
    reads++;
    throw new DOMException('Storage access denied', 'SecurityError');
  } });
  const sandbox = {window};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../director-storage.js'),'utf8'),sandbox);
  let storage;
  assert.doesNotThrow(() => { storage=window.AlleyDirectorStorage.create(); });
  assert.equal(typeof storage.putMedia,'function');
  await assert.rejects(storage.load(),/запретил локальное хранилище/);
  await assert.rejects(storage.save(project()),/запретил локальное хранилище/);
  assert.equal(reads,1,'the denied getter does not run outside the guarded construction');
  const explicit=window.AlleyDirectorStorage.create({indexedDB:null});
  await assert.rejects(explicit.load(),/хранилище недоступно/);
  assert.equal(reads,1,'an explicit provider must not read the restricted global getter');
});

test('blocked late connections close safely, and version changes reopen without discarding data', async () => {
  const h=indexedDBHarness(), storage=storageModule.create({indexedDB:h.indexedDB});
  h.state.blockOpen=true;
  await assert.rejects(storage.load(),/занято другой вкладкой/);
  const old=h.state.opens[0].request;
  h.state.blockOpen=false;
  await storage.save(project());
  h.lateSuccess(old);
  assert.equal(old.result.closed,true);
  const active=h.state.databases.find(db=>!db.closed);
  active.onversionchange();
  assert.equal(active.closed,true);
  assert.equal((await storage.load()).title,'Переулок');
  assert.equal(h.state.opens.length,3);
});

test('invalid or oversized data fails before a database write and bad media never replace a valid file', async () => {
  const h=indexedDBHarness(), storage=storageModule.create({indexedDB:h.indexedDB});
  for(const value of [undefined,{format:'wrong',version:1,scenes:[],media:[]},{...project(),version:2},{...project(),title:'ࠀ'.repeat(400000)}]) {
    await assert.rejects(storage.save(value),/корректным JSON|Некорректный/);
  }
  assert.equal(h.state.opens.length,0);
  for(const change of [
    item=>{item.id='../invalid';}, item=>{item.metadata.size=4;},
    item=>{item.metadata.id='other';}, item=>{item.metadata.name='../Запись.wav';},
    item=>{item.metadata.durationMs=Infinity;}, item=>{item.blob={size:32*1024*1024+1,arrayBuffer(){}};}
  ]) {
    const item=file(); change(item);
    await assert.rejects(storage.putMedia(item),/Недопустимый|Описание/);
  }
  assert.equal(h.state.opens.length,0);
});
