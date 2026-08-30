(function () {
  const results = [];

  function record(name, pass, detail) {
    results.push({ name, pass: !!pass, detail: detail || '' });
  }

  function click(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function runGmail() {
    const gmailBody = document.querySelector('#gmail-compose .Am.Al.editable');
    if (!gmailBody) return Promise.resolve();

    const gmailBtns = document.querySelectorAll('#gmail-compose .renzo-generate-btn');
    const gmailBar = document.querySelector('#gmail-compose .renzo-compose-bar');
    const sendRow = document.querySelector('#gmail-compose .btC');
    const bodyCell = document.querySelector('#gmail-compose td.I5');

    record('gmail: generate button is injected', gmailBtns.length >= 1, 'count=' + gmailBtns.length);
    record(
      'gmail: button is not inside the native send toolbar',
      gmailBtns.length > 0 && ![...gmailBtns].some((b) => sendRow && sendRow.contains(b)),
      gmailBtns.length ? 'insideSend=' + [...gmailBtns].some((b) => sendRow && sendRow.contains(b)) : 'no button'
    );
    record(
      'gmail: button lives in its own compose bar block',
      !!(gmailBar && gmailBtns[0] && gmailBar.contains(gmailBtns[0])),
      gmailBar ? 'bar present' : 'missing .renzo-compose-bar'
    );
    record(
      'gmail: button is not a raw sibling mashed into the message-body cell',
      !(bodyCell && [...gmailBtns].some((b) => bodyCell.contains(b))),
      bodyCell && gmailBtns[0] ? 'inI5=' + bodyCell.contains(gmailBtns[0]) : 'n/a'
    );
    record(
      'gmail: compose bar stays in the compose window (not an overlay)',
      !!(gmailBar && !gmailBar.hasAttribute('data-renzo-overlay') && document.getElementById('gmail-compose').contains(gmailBar)),
      gmailBar ? 'overlay=' + gmailBar.hasAttribute('data-renzo-overlay') : 'no bar'
    );

    if (gmailBtns[0] && gmailBody) {
      const cloned = gmailBtns[0].cloneNode(true);
      gmailBtns[0].parentElement.replaceChild(cloned, gmailBtns[0]);
      click(cloned);
    }

    return wait(50).then(function () {
      const filledGmail = (gmailBody && (gmailBody.textContent || '').indexOf('reconnect') !== -1);
      record(
        'gmail: click generates outreach text even after host clones the button',
        filledGmail,
        gmailBody ? JSON.stringify(gmailBody.textContent) : 'no body'
      );
      let payload = {};
      try { payload = JSON.parse(window.__renzoLastFetch && window.__renzoLastFetch.opts && window.__renzoLastFetch.opts.body || '{}'); } catch (e) {}
      record(
        'gmail: request uses the compose recipient, not the page heading',
        payload.contactName === 'Alex Rivera' && payload.context === 'Gmail compose',
        JSON.stringify(payload)
      );
    });
  }

  function barForHost(host) {
    const body = document.querySelector(host + ' [contenteditable="true"]');
    const id = body && body.getAttribute('data-renzo-id');
    if (id) {
      const bar = document.querySelector('.renzo-compose-bar[data-renzo-for="' + id + '"]');
      if (bar) {
        return { body: body, bar: bar, btns: bar.querySelectorAll('.renzo-generate-btn') };
      }
    }
    return {
      body: body,
      bar: document.querySelector(host + ' .renzo-compose-bar'),
      btns: document.querySelectorAll(host + ' .renzo-generate-btn')
    };
  }

  function assertBarOutsideEmail(host, namePrefix) {
    const found = barForHost(host);
    const body = found.body;
    const btns = found.btns;
    const bar = found.bar;
    const sendRow = document.querySelector(host + ' .btC, ' + host + ' .gU.Up');
    const bodyCell = document.querySelector(host + ' td.I5');
    const signature = document.querySelector(host + ' .gmail_signature, ' + host + ' [data-smartmail="gmail_signature"]');
    const quote = document.querySelector(host + ' .gmail_quote');

    record(namePrefix + ': generate button is injected', btns.length >= 1, 'count=' + btns.length);
    record(
      namePrefix + ': button lives in its own compose bar block',
      !!(bar && btns[0] && bar.contains(btns[0])),
      bar ? 'bar present' : 'missing .renzo-compose-bar'
    );
    record(
      namePrefix + ': button is not inside the editable body',
      btns.length > 0 && ![...btns].some((b) => body && body.contains(b)),
      body && btns[0] ? 'inBody=' + body.contains(btns[0]) : 'n/a'
    );
    record(
      namePrefix + ': button is not inside the signature',
      btns.length > 0 && ![...btns].some((b) => signature && signature.contains(b)),
      signature && btns[0] ? 'inSig=' + signature.contains(btns[0]) : 'no signature'
    );
    if (quote) {
      record(
        namePrefix + ': button is not inside the quoted thread',
        ![...btns].some((b) => quote.contains(b)),
        btns[0] ? 'inQuote=' + quote.contains(btns[0]) : 'n/a'
      );
    }
    record(
      namePrefix + ': button is not in Gmail send/formatting row',
      btns.length > 0 && ![...btns].some((b) => sendRow && sendRow.contains(b)),
      sendRow && btns[0] ? 'inSend=' + sendRow.contains(btns[0]) : 'no .btC (ok if Send is role=button)'
    );
    record(
      namePrefix + ': button is not inside the message-body cell (td.I5)',
      !bodyCell || ![...btns].some((b) => bodyCell.contains(b)),
      bodyCell && btns[0] ? 'inI5=' + bodyCell.contains(btns[0]) : 'no td.I5'
    );
    const sigEl = document.querySelector(host + ' .gmail_signature, ' + host + ' [data-smartmail="gmail_signature"]');
    if (sigEl && btns[0] && bar && sigEl.compareDocumentPosition) {
      const pos = sigEl.compareDocumentPosition(bar);
      const barAfterSig = !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
      record(
        namePrefix + ': chrome bar is after the signature, not above it',
        barAfterSig,
        barAfterSig ? 'after signature' : 'bar is above the signature'
      );
    }
    const innerEditor = document.querySelector(host + ' .aoI');
    const hostSend = document.querySelector(host + ' > .btC, ' + host + ' > .dC, ' + host + ' > .gU.Up');
    if (innerEditor && hostSend && !innerEditor.contains(hostSend)) {
      record(
        namePrefix + ': button is outside the inner .aoI editor card (not above the signature)',
        btns.length > 0 && ![...btns].some((b) => innerEditor.contains(b)),
        btns[0] ? 'inAoI=' + innerEditor.contains(btns[0]) : 'n/a'
      );
    }
    if (bar) {
      record(
        namePrefix + ': reply bar is hosted outside the letter (overlay on document.body)',
        bar.hasAttribute('data-renzo-overlay') && bar.parentElement === document.body && !(body && body.contains(bar)),
        bar.hasAttribute('data-renzo-overlay') ? 'overlay parent=' + (bar.parentElement && bar.parentElement.tagName) : 'in-tree'
      );
    }
    return { body, btns, bar, signature, quote };
  }

  function runGmailReply() {
    const reply = assertBarOutsideEmail('#gmail-reply', 'gmail-reply');
    assertBarOutsideEmail('#gmail-reply-incell', 'gmail-reply-incell');
    assertBarOutsideEmail('#gmail-reply-nosendclass', 'gmail-reply-nosendclass');
    assertBarOutsideEmail('#gmail-reply-thread', 'gmail-reply-thread');

    if (reply.btns[0] && reply.body) {
      click(reply.btns[0]);
    }

    return wait(50).then(function () {
      const text = (reply.body && reply.body.textContent) || '';
      const filled = text.indexOf('reconnect') !== -1;
      const sigKept = !!(reply.signature && reply.signature.isConnected &&
        (reply.signature.textContent || '').indexOf('David Genuth') !== -1);
      const noticeKept = text.indexOf('Confidentiality notice') !== -1;
      const quoteKept = !!(reply.quote && reply.quote.isConnected &&
        (reply.quote.textContent || '').indexOf('Please confirm') !== -1);
      record('gmail-reply: click inserts outreach text into the reply body', filled, JSON.stringify(text.slice(0, 180)));
      record('gmail-reply: click does not wipe the signature', sigKept, reply.signature ? JSON.stringify(reply.signature.textContent) : 'no signature');
      record('gmail-reply: click keeps the confidentiality notice', noticeKept, noticeKept ? 'kept' : text.slice(0, 180));
      record('gmail-reply: click does not wipe the quoted thread', quoteKept, reply.quote ? JSON.stringify(reply.quote.textContent) : 'no quote');

      let payload = {};
      try { payload = JSON.parse(window.__renzoLastFetch && window.__renzoLastFetch.opts && window.__renzoLastFetch.opts.body || '{}'); } catch (e) {}
      record(
        'gmail-reply: request uses the reply-header recipient',
        payload.contactName === 'Marbitzei Torah Orders',
        JSON.stringify(payload)
      );

      if (reply.body && reply.bar) {
        reply.body.insertBefore(reply.bar, reply.body.firstChild);
      }
      if (window.RenzoExtension && window.RenzoExtension.scan) {
        window.RenzoExtension.scan(document.body);
      }
      return wait(80);
    }).then(function () {
      const body = document.querySelector('#gmail-reply [contenteditable="true"]');
      const id = body && body.getAttribute('data-renzo-id');
      const bar = id && document.querySelector('.renzo-compose-bar[data-renzo-for="' + id + '"]');
      record(
        'gmail-reply: swallowed bar is moved back out of the editable',
        !!(bar && body && !body.contains(bar)),
        bar && body ? 'inBody=' + body.contains(bar) + ' overlay=' + bar.hasAttribute('data-renzo-overlay') : 'missing bar/body'
      );
    });
  }

  function runLinkedIn() {
    const classicBody = document.querySelector('#linkedin-classic .msg-form__contenteditable');
    if (!classicBody && !document.getElementById('linkedin-new')) return Promise.resolve();

    const classicBtns = document.querySelectorAll('#linkedin-classic .renzo-generate-btn');
    const classicRow = document.querySelector('#linkedin-classic .msg-form__row');
    const classicBar = document.querySelector('#linkedin-classic .renzo-compose-bar');

    record(
      'linkedin-classic: button injected for ellipsis aria-label compose',
      classicBtns.length >= 1,
      'count=' + classicBtns.length
    );
    record(
      'linkedin-classic: button is not a flex sibling of Send in the input row',
      classicBtns.length > 0 && ![...classicBtns].some((b) => classicRow && classicRow.contains(b) && !b.closest('.renzo-compose-bar')),
      classicBtns.length ? 'inRow=' + [...classicBtns].some((b) => classicRow && classicRow.contains(b)) : 'no button'
    );
    record(
      'linkedin-classic: button lives in its own compose bar block',
      !!(classicBar && classicBtns[0] && classicBar.contains(classicBtns[0])),
      classicBar ? 'bar present' : 'missing .renzo-compose-bar'
    );

    const newBtns = document.querySelectorAll('#linkedin-new .renzo-generate-btn');
    record(
      'linkedin-new: button injected without msg-form class',
      newBtns.length >= 1,
      'count=' + newBtns.length
    );

    if (classicBtns[0] && classicBody) {
      click(classicBtns[0]);
    }

    return wait(50).then(function () {
      const filledLi = classicBody && (classicBody.textContent || '').indexOf('reconnect') !== -1;
      record(
        'linkedin: click generates outreach text in the message box',
        filledLi,
        classicBody ? JSON.stringify(classicBody.textContent) : 'no body'
      );
      let payload = {};
      try { payload = JSON.parse(window.__renzoLastFetch && window.__renzoLastFetch.opts && window.__renzoLastFetch.opts.body || '{}'); } catch (e) {}
      record(
        'linkedin: request uses the conversation name, not the page heading',
        payload.contactName === 'Jordan Lee' && payload.context === 'LinkedIn message',
        JSON.stringify(payload)
      );
    });
  }

  function runReinjection() {
    document.querySelectorAll('.renzo-compose-bar').forEach(function (el) { el.remove(); });
    if (window.RenzoExtension && window.RenzoExtension.scan) {
      window.RenzoExtension.scan(document.body);
    }
    return wait(80).then(function () {
      const host = (location.hostname || '').includes('linkedin') ? '#linkedin-classic' : '#gmail-compose';
      record(
        're-inject: button returns after host removes it',
        document.querySelectorAll(host + ' .renzo-generate-btn').length >= 1,
        'count=' + document.querySelectorAll(host + ' .renzo-generate-btn').length
      );
    });
  }

  function finish() {
    const failed = results.filter(function (r) { return !r.pass; });
    const summary = {
      passed: results.filter(function (r) { return r.pass; }).length,
      failed: failed.length,
      results: results
    };
    const el = document.getElementById('renzo-test-results');
    el.textContent = JSON.stringify(summary, null, 2);
    document.title = failed.length ? 'RENZO_FAIL' : 'RENZO_PASS';
    document.body.dataset.renzoTest = failed.length ? 'fail' : 'pass';
  }

  function run() {
    Promise.resolve()
      .then(runGmail)
      .then(runGmailReply)
      .then(runLinkedIn)
      .then(runReinjection)
      .then(finish)
      .catch(function (err) {
        document.getElementById('renzo-test-results').textContent = String(err && err.stack || err);
        document.title = 'RENZO_FAIL';
        document.body.dataset.renzoTest = 'fail';
      });
  }

  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run);
})();
