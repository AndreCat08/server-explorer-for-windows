// A listener on this PC's loopback address that carries each connection through the SSH session,
// the way `ssh -L` does. Database drivers that insist on dialling a real host and port connect here.
// It takes a random port, accepts nothing from the network, and is closed with the explorer.
const net = require('net');
const ssh = require('../ssh');

function open(serverId, host, port) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    let lastError = '';
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      ssh.forwardOut(serverId, host, port).then(
        (stream) => {
          if (socket.destroyed) {
            stream.destroy();
            return;
          }
          stream.on('error', () => socket.destroy());
          stream.on('close', () => socket.destroy());
          socket.on('close', () => stream.destroy());
          socket.pipe(stream).pipe(socket);
        },
        (err) => {
          // A driver only sees the socket close, so the reason is kept for its error message.
          lastError = /administratively prohibited/i.test(err.message)
            ? 'the server does not allow SSH port forwarding (AllowTcpForwarding is off in sshd_config)'
            : `nothing answered on ${host}:${port} (${err.message})`;
          socket.destroy();
        }
      );
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        get lastError() {
          return lastError;
        },
        close() {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

module.exports = { open };
