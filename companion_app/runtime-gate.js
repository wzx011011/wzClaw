'use strict';

// Runtime 健康门：每次检查绑定配置快照与代次。较早检查的迟到结果不得启动
// 新配置；任何重新检查都会先停掉旧 companion，保证 UI 状态与真实链路一致。
function createRuntimeGate({ probe, start, stop, onStatus, onFailure }) {
  let generation = 0;
  let current = Promise.resolve(null);

  async function check(config) {
    const mine = ++generation;
    const snapshot = Object.freeze({ relayUrl: config.relayUrl, cwd: config.cwd });
    await stop();
    if (mine !== generation) return null;
    onStatus({ category: 'checking', source: null, version: null, detailCode: null });

    const task = Promise.resolve()
      .then(() => probe(snapshot))
      .then(async (status) => {
        if (mine !== generation) return null;
        onStatus(status);
        if (status.category === 'ready') await start(snapshot);
        else onFailure(status);
        return status;
      })
      .catch((error) => {
        if (mine !== generation) return null;
        const status = {
          category: 'app-server-failed', source: null, version: null,
          detailCode: 'UNEXPECTED',
        };
        onStatus(status);
        onFailure(status, error);
        return status;
      });
    current = task;
    return task;
  }

  function invalidate() {
    generation += 1;
  }

  return { check, invalidate, get current() { return current; } };
}

module.exports = { createRuntimeGate };
