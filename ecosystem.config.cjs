module.exports = {
  apps: [{
    name: 'newrrow-bot',
    script: 'index.js',
    kill_timeout: 360000, // 6분 — 회고 완료 대기 (최대 5분) + 여유
    wait_ready: false,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
