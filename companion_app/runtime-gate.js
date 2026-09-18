'use strict';

// Runtime 健康门：只负责「本机 ZCode runtime 预检」与 descriptor 交付。
// 不拥有 relay/device 控制面——设备在线（注册、配对码、断线重连）与
// runtime 健康是两个正交状态，引擎预检失败不得拖垮设备在线（2026-09-18
// 手机反复断线事故根因：probe 失败曾被当成整机开关）。每次检查绑定配置
// 快照与代次：较早检查的迟到结果不得交付给新配置。
function createRuntimeGate({ probe, apply, onStatus, onFailure }) {
  let generation = 0;
  let current = Promise.resolve(null);

  async function check(config) {
    const mine = ++generation;
    const snapshot = Object.freeze({ relayUrl: config.relayUrl, cwd: config.cwd });
    onStatus({ category: 'checking', source: null, version: null, detailCode: null });

    const task = Promise.resolve()
      .then(() => probe(snapshot))
      .then(async (status) => {
        if (mine !== generation) return null;
        onStatus(status);
        if (status.category === 'ready') {
          // ready 必携带 descriptor（probeZcodeRuntime 契约）；缺失按失败
          // 处理而非静默跳过——静默丢弃=缺陷。
          if (status.runtimeDescriptor) {
            await apply(status.runtimeDescriptor);
          } else {
            onFailure({ ...status, category: 'app-server-failed', detailCode: 'BAD_DESCRIPTOR' });
          }
        } else {
          onFailure(status);
        }
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
