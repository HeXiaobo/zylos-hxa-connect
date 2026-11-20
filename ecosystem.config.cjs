const { getRuntimePaths } = require('./src/lib/config-path.cjs');

const {
  skillDir,
  errorLogPath,
  outLogPath,
} = getRuntimePaths();

module.exports = {
  apps: [{
    name: 'zylos-hxa-connect',
    script: 'src/bot.js',
    cwd: skillDir,
    env: {
      NODE_ENV: 'production'
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    error_file: errorLogPath,
    out_file: outLogPath,
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
