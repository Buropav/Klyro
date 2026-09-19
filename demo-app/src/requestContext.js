const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function run(store, fn) {
  return als.run(store, fn);
}

function increment(key) {
  const store = als.getStore();
  if (store) {
    store[key] = (store[key] || 0) + 1;
  }
}

function getStore() {
  return als.getStore();
}

module.exports = { run, increment, getStore };
