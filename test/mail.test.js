'use strict';
// MIME-Zerlegung ohne Netzwerk (erfundene Nachrichten)
const { test } = require('node:test');
const assert = require('node:assert');
const mail = require('../mail');

const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600, 65)]);
const b64 = pdf.toString('base64').replace(/(.{76})/g, '$1\r\n');

test('PDF-Anhang mit RFC-2231-Dateiname und kodiertem Betreff', () => {
  const raw = [
    'From: =?utf-8?Q?J=C3=BCrgen?= <juergen@example.org>',
    'Subject: =?utf-8?B?UmVjaG51bmcgR2Viw6R1ZGU=?=',
    'Message-ID: <abc@example.org>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Gr=C3=BC=C3=9Fe',
    '--XYZ',
    'Content-Type: application/octet-stream',
    "Content-Disposition: attachment; filename*=UTF-8''Rechnung%20Geb%C3%A4ude.pdf",
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--XYZ--',
    '',
  ].join('\r\n');
  const m = mail.parseMessage(Buffer.from(raw, 'latin1'));
  assert.equal(m.subject, 'Rechnung Gebäude');
  assert.equal(m.from, 'Jürgen <juergen@example.org>');
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'Rechnung Gebäude.pdf');
  assert.equal(m.attachments[0].mime, 'application/pdf');
  assert.ok(m.attachments[0].data.equals(pdf));
});

test('weitergeleitete Mail als Anhang, kleines Signaturbild wird ignoriert', () => {
  const inner = ['From: Firma <info@firma.example>', 'Subject: Angebot', 'Content-Type: multipart/mixed; boundary=in1', '',
    '--in1', 'Content-Type: application/pdf; name="angebot.pdf"', 'Content-Transfer-Encoding: base64', '', b64, '--in1--', ''].join('\r\n');
  const raw = ['From: ich@example.org', 'Subject: WG: Angebot', 'Content-Type: multipart/mixed; boundary=out', '',
    '--out', 'Content-Type: image/png', 'Content-Disposition: inline; filename="logo.png"', 'Content-Transfer-Encoding: base64', '',
    Buffer.alloc(800, 1).toString('base64'), '--out', 'Content-Type: message/rfc822', '', inner, '--out--', ''].join('\r\n');
  const m = mail.parseMessage(Buffer.from(raw, 'latin1'));
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'angebot.pdf');
  assert.equal(m.forwardedFrom, 'Firma <info@firma.example>');
});
