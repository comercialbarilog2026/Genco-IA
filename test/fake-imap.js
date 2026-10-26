// Servidor IMAP de mentira, só para os testes automáticos (localhost, sem TLS).
const net = require("node:net");

const CRLF = "\r\n";
const D = (s, n) => s.split("\n").join(CRLF) + (n ? CRLF : "");
const ago = h => new Date(Date.now() - h * 3600e3);
const imapDate = d => { const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]; const p = n => String(n).padStart(2, "0"); return `${p(d.getUTCDate())}-${m}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`; };

function mailboxes() {
  const pdf = Buffer.from("%PDF-1.4 invoice 2400 cartons").toString("base64");
  const inbox = [
    { flags: [], at: ago(30), raw: Buffer.from(D(`From: =?ISO-8859-1?Q?Jo=E3o_Concei=E7=E3o?= <joao@cliente.com.br>
To: Operacional <operacional@brcomexx.com.br>
Subject: =?ISO-8859-1?Q?Cont=EAiner_parado_-_segunda_vez?=
Message-ID: <m1@cliente.com.br>
Date: ${ago(30).toUTCString()}
Content-Type: multipart/mixed; boundary="XX"

--XX
Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: quoted-printable

Bom dia, segunda vez que pe=E7o: o cont=EAiner est=E1 parado e a carga =E9 perec=EDvel. Preciso de retorno urgente.
--XX
Content-Type: application/pdf; name="Invoice 2291.pdf"
Content-Disposition: attachment; filename="Invoice 2291.pdf"
Content-Transfer-Encoding: base64

${pdf}
--XX--
`, 1), "latin1") },
    { flags: ["\\Seen"], at: ago(5), raw: Buffer.from(D(`From: Fornecedor <vendas@fornecedor.com>
To: caio@brcomexx.com.br
Subject: Tabela de precos 2027
Message-ID: <m2@fornecedor.com>

Segue tabela.
`, 1)) },
    { flags: [], at: ago(20), raw: Buffer.from(D(`From: Maria <maria@cliente2.com>
To: operacional@brcomexx.com.br
Subject: Status do embarque
Message-ID: <m3@cliente2.com>

Qual o status?
`, 1)) },
    { flags: [], at: ago(2), raw: Buffer.from(D(`From: Rafael Costa <rafael.costa@brcomexx.com.br>
To: pedro@cliente3.com
Cc: operacional@brcomexx.com.br
Subject: RE: Agendamento
Message-ID: <m4@brcomexx.com.br>
In-Reply-To: <m5@cliente3.com>
References: <m5@cliente3.com>

Agendado para quarta.
`, 1)) },
    { flags: [], at: ago(8), raw: Buffer.from(D(`From: Pedro <pedro@cliente3.com>
To: operacional@brcomexx.com.br
Subject: Agendamento
Message-ID: <m5@cliente3.com>

Podem agendar a retirada?
`, 1)) },
    { flags: ["\\Answered", "\\Seen"], at: ago(12), raw: Buffer.from(D(`From: Lia <lia@cliente4.com>
To: operacional@brcomexx.com.br
Subject: Obrigada
Message-ID: <m6@cliente4.com>

Obrigada pelo retorno.
`, 1)) }
  ];
  const sent = [{ flags: ["\\Seen"], at: ago(10), raw: Buffer.from(D(`From: operacional@brcomexx.com.br
To: maria@cliente2.com
Subject: RE: Status do embarque
In-Reply-To: <m3@cliente2.com>
References: <m3@cliente2.com>

Chega sexta.
`, 1)) }];
  const box = list => list.map((m, i) => ({ ...m, uid: i + 1 }));
  return { INBOX: { flags: [], msgs: box(inbox) }, Enviados: { flags: ["\\Sent"], msgs: box(sent) }, Rascunhos: { flags: ["\\Drafts"], msgs: [] } };
}

function start({ user = "caio@brcomexx.com.br", pass = "senha-imap-1" } = {}) {
  const boxes = mailboxes();
  const logins = [];
  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0), pending = null, sel = null;
    const w = s => sock.write(s);
    w("* OK Fake IMAP pronto" + CRLF);
    const handle = (line, literal) => {
      const m = line.match(/^(\S+) (UID )?(\S+) ?(.*)$/i); if (!m) return;
      const [, tag, uid, cmdRaw, args] = m, cmd = cmdRaw.toUpperCase();
      const ok = (t = "feito") => w(`${tag} OK ${t}${CRLF}`);
      if (cmd === "CAPABILITY") { w("* CAPABILITY IMAP4rev1 UIDPLUS" + CRLF); return ok(); }
      if (cmd === "LOGIN") {
        const q = args.match(/^"((?:[^"\\]|\\.)*)"\s*(?:"((?:[^"\\]|\\.)*)")?/);
        const u = q[1], p = literal ? literal.toString("utf8") : (q[2] || "").replace(/\\(.)/g, "$1");
        logins.push(u);
        return u === user && p === pass ? ok("logado") : w(`${tag} NO [AUTHENTICATIONFAILED] credenciais invalidas${CRLF}`);
      }
      if (cmd === "LIST") { for (const [n, b] of Object.entries(boxes)) w(`* LIST (\\HasNoChildren${b.flags.map(f => " " + f).join("")}) "/" "${n}"${CRLF}`); return ok(); }
      if (cmd === "SELECT" || cmd === "EXAMINE") { sel = boxes[args.replace(/"/g, "")]; if (!sel) return w(`${tag} NO sem pasta${CRLF}`); w(`* ${sel.msgs.length} EXISTS${CRLF}* OK [UIDVALIDITY 7] ok${CRLF}`); return ok(); }
      if (uid && cmd === "SEARCH") { w(`* SEARCH ${sel.msgs.map(x => x.uid).join(" ")}${CRLF}`); return ok(); }
      if (uid && cmd === "FETCH") {
        const [set, ...rest] = args.split(" "); const items = rest.join(" ");
        const want = new Set(set.split(",").map(Number));
        sel.msgs.forEach((x, i) => {
          if (!want.has(x.uid)) return;
          const parts = [`UID ${x.uid}`];
          if (/FLAGS/.test(items)) parts.push(`FLAGS (${x.flags.join(" ")})`);
          if (/RFC822\.SIZE/.test(items)) parts.push(`RFC822.SIZE ${x.raw.length}`);
          if (/INTERNALDATE/.test(items)) parts.push(`INTERNALDATE "${imapDate(x.at)}"`);
          w(`* ${i + 1} FETCH (${parts.join(" ")}`);
          const hm = items.match(/BODY\.PEEK\[(HEADER\.FIELDS \([^)]*\))?\]/);
          if (hm) {
            const s = x.raw.toString("latin1"), cut = s.indexOf("\r\n\r\n");
            const data = hm[1] ? Buffer.from(s.slice(0, cut + 4), "latin1") : x.raw;
            w(` BODY[${hm[1] || ""}] {${data.length}}${CRLF}`); sock.write(data);
          }
          w(")" + CRLF);
        });
        return ok();
      }
      if (cmd === "APPEND") {
        const b = boxes[args.match(/^"([^"]+)"/)[1]]; const nuid = (b.msgs.at(-1)?.uid || 0) + 1;
        b.msgs.push({ uid: nuid, flags: ["\\Draft", "\\Seen"], at: new Date(), raw: literal });
        return ok(`[APPENDUID 7 ${nuid}] gravado`);
      }
      if (uid && cmd === "STORE") { const u = Number(args.split(" ")[0]); const x = sel.msgs.find(y => y.uid === u); if (x) x.flags.push("\\Deleted"); return ok(); }
      if (uid && cmd === "EXPUNGE") { const u = Number(args); sel.msgs = sel.msgs.filter(y => !(y.uid === u && y.flags.includes("\\Deleted"))); for (const [k, v] of Object.entries(boxes)) if (v === sel) boxes[k] = sel; return ok(); }
      if (cmd === "LOGOUT") { w("* BYE ate logo" + CRLF); ok(); return sock.end(); }
      w(`${tag} BAD comando desconhecido${CRLF}`);
    };
    sock.on("data", d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (pending) {
          if (buf.length < pending.n + 2) return;
          const lit = buf.subarray(0, pending.n); buf = buf.subarray(pending.n + 2);
          const p = pending; pending = null; handle(p.line, lit); continue;
        }
        const i = buf.indexOf("\r\n"); if (i < 0) return;
        const line = buf.subarray(0, i).toString("utf8"); buf = buf.subarray(i + 2);
        const lm = line.match(/^(.*) \{(\d+)\}$/);
        if (lm) { pending = { line: lm[1], n: Number(lm[2]) }; w("+ pode enviar" + CRLF); continue; }
        handle(line);
      }
    });
    sock.on("error", () => {});
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port, boxes, logins, user, pass })));
}

module.exports = { start };
