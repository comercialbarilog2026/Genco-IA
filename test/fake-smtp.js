// Servidor SMTP de mentira para os testes: guarda as mensagens recebidas.
const net = require("node:net");
function start() {
  const inbox = [];
  const server = net.createServer(sock => {
    let buf = "", data = null, msg = {};
    const w = s => sock.write(s + "\r\n");
    w("220 fake smtp");
    sock.on("data", d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data !== null) {
          if (line === ".") { msg.raw = data.join("\r\n"); inbox.push(msg); msg = {}; data = null; w("250 ok"); }
          else data.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") { sock.write("250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n"); }
        else if (cmd === "AUTH") w("235 ok");
        else if (cmd === "MAIL") { msg.from = line; w("250 ok"); }
        else if (cmd === "RCPT") { msg.to = (line.match(/<([^>]+)>/) || [])[1]; w("250 ok"); }
        else if (cmd === "DATA") { data = []; w("354 go"); }
        else if (cmd === "QUIT") { w("221 bye"); sock.end(); }
        else w("250 ok");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port, inbox })));
}
const bodyText = raw => { const parts = raw.split(/\r\n\r\n/); return parts.map(p => { try { return Buffer.from(p.replace(/\s/g, ""), "base64").toString("utf8"); } catch { return ""; } }).join("\n"); };
module.exports = { start, bodyText };
