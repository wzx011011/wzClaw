'use strict';

const { log, warn } = require('./logger');

let admin = null;
try {
  admin = require('firebase-admin');
} catch (_) {
  admin = null;
}

const MAX_MULTICAST_TOKENS = 500;
const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

class FirebaseWakePushProvider {
  constructor(messaging) {
    this._messaging = messaging;
  }

  async sendWakePush(tokens, payload) {
    const uniqueTokens = Array.from(new Set(tokens.filter((token) => typeof token === 'string' && token.trim())));
    if (uniqueTokens.length === 0) {
      return { sentCount: 0, invalidTokens: [] };
    }

    let sentCount = 0;
    const invalidTokens = [];

    for (let index = 0; index < uniqueTokens.length; index += MAX_MULTICAST_TOKENS) {
      const batch = uniqueTokens.slice(index, index + MAX_MULTICAST_TOKENS);
      const response = await this._messaging.sendEachForMulticast({
        tokens: batch,
        android: {
          priority: 'high',
          ttl: 30 * 1000,
        },
        notification: _buildNotification(payload),
        data: _buildDataPayload(payload),
      });

      sentCount += response.successCount;
      response.responses.forEach((entry, entryIndex) => {
        if (!entry.success && _isInvalidTokenError(entry.error)) {
          invalidTokens.push(batch[entryIndex]);
        }
      });
    }

    return {
      sentCount,
      invalidTokens,
    };
  }
}

function createWakePushProvider() {
  if (!admin) {
    warn('Wake push disabled: firebase-admin is not installed');
    return null;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!serviceAccountJson && !credentialsPath) {
    log('Wake push disabled: no Firebase credentials configured');
    return null;
  }

  try {
    const app = admin.apps.length > 0
      ? admin.app()
      : admin.initializeApp(_buildFirebaseAppConfig(serviceAccountJson));
    return new FirebaseWakePushProvider(admin.messaging(app));
  } catch (err) {
    warn(`Wake push disabled: Firebase init failed (${err.message})`);
    return null;
  }
}

function _buildFirebaseAppConfig(serviceAccountJson) {
  if (!serviceAccountJson) {
    return {
      credential: admin.credential.applicationDefault(),
    };
  }

  const parsed = JSON.parse(serviceAccountJson);
  return {
    credential: admin.credential.cert(parsed),
  };
}

function _buildNotification(payload) {
  switch (payload.event) {
    case 'stream:agent:done':
      return {
        title: 'wzxClaw',
        body: '任务执行完成，点按恢复连接',
      };
    case 'stream:agent:error':
      return {
        title: 'wzxClaw',
        body: '任务执行出错，点按恢复连接',
      };
    case 'task:changed':
      return {
        title: 'wzxClaw',
        body: '任务状态已更新，点按恢复连接',
      };
    case 'session:changed':
    case 'session:active':
      return {
        title: 'wzxClaw',
        body: '会话已更新，点按恢复连接',
      };
    default:
      return {
        title: 'wzxClaw',
        body: '桌面端有新动态，点按恢复连接',
      };
  }
}

function _buildDataPayload(payload) {
  return {
    type: 'wake',
    wakeEvent: payload.event || 'unknown',
    desktopId: payload.desktopId || '',
    payloadJson: JSON.stringify(payload.data || {}),
  };
}

function _isInvalidTokenError(error) {
  if (!error) return false;
  const code = error.code || error.errorInfo?.code;
  return INVALID_TOKEN_CODES.has(code);
}

module.exports = {
  FirebaseWakePushProvider,
  createWakePushProvider,
};