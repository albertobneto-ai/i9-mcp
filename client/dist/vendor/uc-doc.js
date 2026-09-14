(function () {
  var API = 'https://i9-mcp-da48589780b2.herokuapp.com';
  var CFG = window.__UC__;                       // {docId, jsonPath, fileBase, rodada}
  var all = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var txt = function (el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); };

  // ---------------------------------------------------------------- comentários (rota pública do i9)
  function lerSalvos() {
    return fetch(API + '/api/uc/' + encodeURIComponent(CFG.docId) + '/comentarios?rodada=' + CFG.rodada,
      { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }
  function marcarAplicada(rodada) {
    return fetch(API + '/api/uc/' + encodeURIComponent(CFG.docId) + '/comentarios/' + rodada + '/aplicar',
      { method: 'POST' }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          return j;
        });
      });
  }
  function gravarSalvos(comentarios) {
    return fetch(API + '/api/uc/' + encodeURIComponent(CFG.docId) + '/comentarios', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rodada: CFG.rodada, comentarios: comentarios })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  window.__UC_API__ = { ler: lerSalvos, gravar: gravarSalvos };

  // ---------------------------------------------------------------- aplicar comentários ao documento
  function limpar() {
    all('.uapl').forEach(function (n) { n.remove(); });
    all('.uc-chip.crev').forEach(function (n) { n.remove(); });
    all('[data-duv-off]').forEach(function (n) { n.style.display = ''; n.removeAttribute('data-duv-off'); });
  }
  function aplicar(dados) {
    limpar();
    var c = (dados && dados.comentarios) || {}, n = 0;
    Object.keys(c).forEach(function (k) {
      var item = c[k], texto = (item && item.comentario) || '';
      if (!texto) return;
      var box = document.querySelector('.cbox[data-ckey="' + k + '"]');
      if (!box) return;
      var bloco = document.createElement('div');
      bloco.className = 'usec uapl';
      bloco.innerHTML = '<b>Definição aplicada na revisão:</b> ';
      bloco.appendChild(document.createTextNode(texto));
      var det = box.closest('details[data-ckey="' + k + '"]');
      if (det) {
        var body = det.querySelector(':scope > .ubody');
        // entra no contexto do item: logo após as regras, antes de melhorias e caminhos
        var depois = null;
        all(':scope > .usec', body).forEach(function (sec) {
          var b = sec.querySelector('b');
          if (b && /Regras de validação|Regra de preenchimento|^Valores|^Categorias|^Valor aplicável/.test(txt(b)))
            depois = sec;
        });
        if (depois) body.insertBefore(bloco, depois.nextSibling);
        else body.insertBefore(bloco, box.nextSibling);
        // o item comentado sai do regime de dúvida
        all(':scope > summary .uc-chip.cd', det).forEach(function (ch) {
          ch.setAttribute('data-duv-off', '1'); ch.style.display = 'none';
        });
        all(':scope > .ubody > .uduv', det).forEach(function (d) {
          d.setAttribute('data-duv-off', '1'); d.style.display = 'none';
        });
        var sum = det.querySelector(':scope > summary');
        var chip = document.createElement('span');
        chip.className = 'uc-chip crev'; chip.textContent = 'revisado';
        sum.insertBefore(chip, sum.querySelector('.uchips') || sum.querySelector('.cbtn'));
      } else {
        var cel = box.closest('td');
        if (cel) { cel.appendChild(bloco); var tr = cel.closest('tr'); if (tr) tr.style.display = ''; }
      }
      n++;
    });
    var info = document.querySelector('.uinfo');
    if (info) {
      info.textContent = info.textContent.replace(/ · \d+ (item|itens) revisados?/, '');
      if (n) info.textContent += ' · ' + n + (n === 1 ? ' item revisado' : ' itens revisados');
    }
    return n;
  }

  // ---------------------------------------------------------------- Word
  var LIBS = {};
  function lib(nome, url, global) {
    if (LIBS[nome]) return LIBS[nome];
    LIBS[nome] = new Promise(function (res, rej) {
      if (window[global]) return res(window[global]);
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status); return r.text();
      }).then(function (codigo) {
        var s = document.createElement('script');
        s.src = URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' }));
        s.onload = function () { window[global] ? res(window[global]) : rej(new Error(nome)); };
        s.onerror = function () { rej(new Error(nome)); };
        document.head.appendChild(s);
      }).catch(rej);
    });
    LIBS[nome].catch(function () { LIBS[nome] = null; });
    return LIBS[nome];
  }
  function svgPng(svg) {
    return new Promise(function (res) {
      try {
        var vb = svg.getAttribute('viewBox').split(/\s+/), w = +vb[2], h = +vb[3];
        var s = new XMLSerializer().serializeToString(svg);
        if (s.indexOf('xmlns=') < 0) s = s.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas'); c.width = w * 3; c.height = h * 3;
          var x = c.getContext('2d'); x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, c.width, c.height);
          x.drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(function (b) {
            b ? b.arrayBuffer().then(function (ab) { res({ data: ab, w: w, h: h }); }) : res(null);
          }, 'image/png');
        };
        img.onerror = function () { res(null); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
      } catch (e) { res(null); }
    });
  }

  // ---- leitura do documento em memória (espelha o HTML, já com as decisões aplicadas)
  function visivel(el) { return el.style.display !== 'none'; }
  function lerChips(sum) {
    return all('.uc-chip', sum).filter(visivel).map(function (c) {
      var cls = c.className;
      return { t: txt(c), forte: /\bcs\b|\bcd\b|\bcp\b|\bcrev\b/.test(cls) };
    });
  }
  function lerBlocos(det) {
    var body = det.querySelector(':scope > .ubody'), res = [];
    if (!body) return res;
    all(':scope > *', body).forEach(function (el) {
      if (el.tagName === 'DETAILS' || el.classList.contains('cbox') || !el.classList.contains('usec')) return;
      if (!visivel(el)) return;
      var rec = el.querySelector('.urec');
      if (rec) {
        var br = rec.querySelector('b');
        res.push({ tipo: 'rec', rotulo: txt(br), texto: txt(rec).replace(txt(br), '').trim() });
        return;
      }
      var b = el.querySelector('b'), rotulo = b ? txt(b) : '';
      var pills = all('.upill', el).map(function (p) { return txt(p); });
      var corpo = pills.length ? pills.join(' · ') : txt(el).replace(rotulo, '').trim();
      var tipo = el.classList.contains('uapl') ? 'decisao'
        : el.classList.contains('uduv') ? 'duvida' : 'texto';
      res.push({ tipo: tipo, rotulo: rotulo, texto: corpo });
    });
    return res;
  }
  function lerNo(det) {
    var sum = det.querySelector(':scope > summary');
    var cls = det.className;
    var tipo = /u-root/.test(cls) ? 'root' : /u-fam/.test(cls) ? 'fam'
      : /u-grp/.test(cls) ? 'grp' : 'attr';
    var lvl = sum.querySelector('.ulvl');
    var limpo = sum.cloneNode(true);
    all('.uc-chip, .cbtn, .uchips, .ulvl', limpo).forEach(function (x) { x.remove(); });
    var body = det.querySelector(':scope > .ubody');
    return { tipo: tipo, lvl: lvl ? txt(lvl) : '', nome: txt(limpo), chips: lerChips(sum),
      blocos: lerBlocos(det),
      filhos: body ? all(':scope > details', body).map(lerNo) : [] };
  }
  function lerTabela(t) {
    var head = all('thead th', t).map(function (th) { return txt(th); });
    var rows = [];
    all('tbody tr', t).forEach(function (tr) {
      var crow = tr.querySelector('td.crow');
      if (crow) {
        var apl = crow.querySelector('.uapl');
        if (apl) rows.push({ decisao: txt(apl).replace(/^Decisão da revisão:\s*/, '') });
        return;
      }
      var cels = all(':scope > td', tr);
      if (!cels.length) return;
      var c2 = cels.map(function (c) {
        var k = c.cloneNode(true);
        all('.cbtn, .cbox', k).forEach(function (x) { x.remove(); });
        return txt(k);
      });
      rows.push({ cells: c2 });
    });
    return { tipo: 'tabela', cols: head.length || 2, head: head, rows: rows,
      mono: !!t.querySelector('td.mono') };
  }
  function lerDocumento() {
    var cap = document.querySelector('.cover');
    var d = {
      kicker: txt(cap.querySelector('.kicker')),
      titulo: txt(cap.querySelector('h1')),
      sub: txt(cap.querySelector('.sub')),
      meta: all('.cover .meta div').map(function (m) {
        return [txt(m.querySelector('dt')), txt(m.querySelector('dd'))]; }),
      kpis: all('.kpi').map(function (k) {
        return [txt(k.querySelector('.l')), txt(k.querySelector('.v'))]; }),
      toc: all('.toc a').map(function (a) {
        var n = a.querySelector('.n'), t = a.cloneNode(true);
        all('.n', t).forEach(function (x) { x.remove(); });
        return [n ? txt(n) : '', txt(t)];
      }),
      rodape: all('footer span').map(function (x) { return txt(x); }).join('  ·  '),
      secoes: []
    };
    all('section[id^="s"]').forEach(function (sec) {
      var itens = [];
      all(':scope > *', sec).forEach(function (el) {
        if (el.classList.contains('sh')) return;
        if (el.tagName === 'TABLE') { itens.push(lerTabela(el)); return; }
        if (el.tagName === 'H3' && el.classList.contains('umodel')) {
          itens.push({ tipo: 'titulo', texto: txt(el) }); return; }
        if (el.classList.contains('ubar')) {
          var i = el.querySelector('.uinfo');
          if (i) itens.push({ tipo: 'info', texto: txt(i) });
          return;
        }
        if (el.classList.contains('utree')) {
          itens.push({ tipo: 'arvore', nos: all(':scope > details', el).map(lerNo) }); return; }
        if (el.tagName === 'FIGURE') {
          itens.push({ tipo: 'figura', svg: el.querySelector('svg'),
            legenda: txt(el.querySelector('figcaption')) }); return; }
        if (el.classList.contains('call')) {
          itens.push({ tipo: 'call', rotulo: txt(el.querySelector('.cl')),
            texto: txt(el.querySelector('p')) }); return; }
        var t = txt(el);
        if (t) itens.push({ tipo: 'texto', texto: t });
      });
      var sh = sec.querySelector('.sh');
      d.secoes.push({ num: sh ? txt(sh.querySelector('.num')) : '',
        titulo: txt(sec.querySelector('h2')), itens: itens });
    });
    return d;
  }

  // ---- montagem do Word (mesmo visual do HTML)
  function montarWord(D, dados, figuras) {
    var P = D.Paragraph, T = D.TextRun, H = D.HeadingLevel, AL = D.AlignmentType,
        WT = D.WidthType, SH = D.ShadingType, BS = D.BorderStyle, VA = D.VerticalAlign,
        TL = D.TableLayoutType;
    var FONT = 'Aptos', TX = '0D0D0D', TX2 = '3A3A3A', MUT = '6B6B6B',
        BD = 'D9D9D9', S1 = 'F2F3F5', S2 = 'E8E9EC';
    var PAGE_W = 11906, MG = 1134, LARG = PAGE_W - MG * 2;
    var nada = { top: { style: BS.NONE }, bottom: { style: BS.NONE },
                 left: { style: BS.NONE }, right: { style: BS.NONE } };
    var caixa = function (cor) {
      var l = { style: BS.SINGLE, size: 6, color: cor || BD, space: 8 };
      var v = { style: BS.SINGLE, size: 6, color: cor || BD, space: 12 };
      return { top: l, left: v, bottom: l, right: v };   // a ordem importa no XML do Word
    };
    var IND = { root: 0, fam: 0, grp: 140, attr: 300 };
    var li = function (c) { return { style: BS.SINGLE, size: 4, color: c || BD }; };
    function tx(t, o) {
      o = o || {};
      return new P({ alignment: o.align, spacing: { before: o.before || 0,
          after: o.after === undefined ? 100 : o.after },
        indent: o.indent, border: o.border, keepNext: o.keepNext,
        shading: o.fill ? fundo(o.fill) : undefined,
        children: [new T({ text: t, font: FONT, size: o.size || 20, bold: !!o.bold,
          color: o.color || TX, allCaps: !!o.caps, characterSpacing: o.track })] });
    }
    function rotulado(r, c, o) {
      o = o || {};
      return new P({ spacing: { before: o.before || 0, after: o.after === undefined ? 100 : o.after,
          line: 260 },
        indent: o.indent,
        border: o.border, shading: o.fill ? fundo(o.fill) : undefined,
        children: [new T({ text: r + ' ', font: FONT, size: o.size || 20, bold: true, color: o.color || TX }),
                   new T({ text: c, font: FONT, size: o.size || 20, color: o.color || TX })] });
    }
    var fundo = function (cor) {
      // escuro em modo sólido: o Word ignora o tema e pinta a cor pedida
      return cor === TX ? { type: SH.SOLID, color: TX, fill: TX }
                        : { type: SH.CLEAR, color: 'auto', fill: cor };
    };
    function cel(conteudo, o) {
      o = o || {};
      return new D.TableCell({ width: { size: o.w, type: WT.DXA },
        shading: o.fill ? fundo(o.fill) : undefined,
        margins: { top: 90, bottom: 90, left: 130, right: 130 },
        columnSpan: o.span, verticalAlign: o.vAlign, borders: o.borders,
        children: Array.isArray(conteudo) ? conteudo : [conteudo] });
    }
    var filhos = [];
    // capa
    filhos.push(new D.Table({ width: { size: LARG, type: WT.DXA }, columnWidths: [LARG],
      layout: TL.FIXED, borders: nada,
      rows: [new D.TableRow({ height: { value: 4200, rule: 'atLeast' }, children: [
        new D.TableCell({ width: { size: LARG, type: WT.DXA }, borders: nada,
          shading: fundo(TX), verticalAlign: VA.CENTER,
          margins: { top: 500, bottom: 500, left: 520, right: 400 },
          children: [
            tx(dados.kicker, { size: 16, color: 'FFFFFF', caps: true, track: 30, after: 260 }),
            tx(dados.titulo, { size: 44, bold: true, color: 'FFFFFF', after: 160 }),
            tx(dados.sub, { size: 22, color: 'C9C9C9', after: 320 }),
            new P({ spacing: { after: 0 }, children: dados.meta.reduce(function (acc, m, i) {
              return acc.concat([
                new T({ text: (i ? '      ' : '') + m[0].toUpperCase() + '  ', font: FONT, size: 15,
                  color: '9A9A9A', characterSpacing: 20 }),
                new T({ text: m[1], font: FONT, size: 19, color: 'FFFFFF' })]);
            }, []) })
          ] })] })] }));
    filhos.push(tx('', { after: 240 }));
    // indicadores
    dados.kpis = dados.kpis.filter(function (k) { return !/fluxo|passo|desvio|escolha/i.test(k[0]); });
    if (dados.kpis.length) {
      var w = Math.floor(LARG / dados.kpis.length);
      filhos.push(new D.Table({ width: { size: LARG, type: WT.DXA },
        columnWidths: dados.kpis.map(function () { return w; }), layout: TL.FIXED,
        rows: [new D.TableRow({ children: dados.kpis.map(function (k) {
          return cel([tx(k[0], { size: 14, color: MUT, caps: true, track: 20, after: 60 }),
                      tx(k[1], { size: 34, bold: true, after: 0 })],
            { w: w, fill: S1, borders: { top: li(), bottom: li(), left: li(), right: li() } });
        }) })] }));
      filhos.push(tx('', { after: 240 }));
    }
    // sumário
    filhos.push(tx('Conteúdo', { size: 15, color: MUT, caps: true, track: 30, after: 120 }));
    dados.toc.filter(function (t) { return t[0] === '01'; }).forEach(function (t) {
      filhos.push(new P({ spacing: { after: 60 }, border: { bottom: li(S2) },
        children: [new T({ text: t[0] + '   ', font: FONT, size: 17, color: MUT }),
                   new T({ text: t[1], font: FONT, size: 20, color: TX })] }));
    });
    // árvore
    var NIV = { root: H.HEADING_2, fam: H.HEADING_3, grp: H.HEADING_4, attr: H.HEADING_5 };
    var NVL = { root: 1, fam: 2, grp: 3, attr: 4 };
    var TAM = { root: 26, fam: 23, grp: 21, attr: 20 };
    function no(n) {
      var ind = IND[n.tipo];
      var fundoNo = n.tipo === 'root' ? TX : n.tipo === 'fam' ? S2 : n.tipo === 'grp' ? S1 : 'FFFFFF';
      var cor = n.tipo === 'root' ? 'FFFFFF' : TX;
      var borda = caixa(n.tipo === 'root' ? TX : BD);
      var runs = [];
      if (n.lvl) {
        runs.push(new T({ text: ' ' + n.lvl + ' ', font: FONT, size: 14, bold: true,
          color: n.tipo === 'root' ? TX : 'FFFFFF', allCaps: true, characterSpacing: 20,
          shading: fundo(n.tipo === 'root' ? 'FFFFFF' : TX) }));
        runs.push(new T({ text: '  ', font: FONT }));
      }
      runs.push(new T({ text: n.nome, font: FONT, size: TAM[n.tipo], bold: true, color: cor }));
      if (n.chips.length) {
        runs.push(new T({ text: '\t', font: FONT }));
        n.chips.forEach(function (c, i) {
          runs.push(new T({ text: ' ' + c.t + ' ', font: FONT, size: 15, bold: c.forte,
            color: c.forte ? TX : TX2,
            shading: fundo(c.forte ? S2 : 'F7F8F9') }));
          if (i < n.chips.length - 1) runs.push(new T({ text: '  ', font: FONT, size: 15 }));
        });
      }
      filhos.push(new P({ heading: NIV[n.tipo], keepNext: true, outlineLevel: NVL[n.tipo],
        border: borda, shading: fundo(fundoNo),
        indent: { left: ind }, tabStops: [{ type: D.TabStopType.RIGHT, position: LARG - ind - 220 }],
        spacing: { before: n.tipo === 'attr' ? 180 : 240, after: 120, line: 260 },
        children: runs }));
      n.blocos.forEach(function (b) {
        var opts = { indent: { left: ind }, border: borda, before: 80,
          fill: b.tipo === 'duvida' ? S2 : b.tipo === 'rec' ? S1 : b.tipo === 'decisao' ? TX : fundoNo,
          color: b.tipo === 'decisao' ? 'FFFFFF' : TX, after: 60 };
        filhos.push(b.rotulo
          ? rotulado(b.rotulo || 'Decisão da revisão:', b.texto, opts)
          : tx(b.texto, opts));
      });
      // separa um cartão do seguinte: sem esta linha sem borda, o Word funde as caixas
      filhos.push(new P({ spacing: { after: 0, line: 120 }, children: [] }));
      n.filhos.forEach(no);
    }

    function tabela(t) {
      var larguras = t.cols === 2
        ? [Math.round(LARG * 0.28), LARG - Math.round(LARG * 0.28)]
        : t.head.map(function () { return Math.floor(LARG / t.cols); });
      larguras[larguras.length - 1] = LARG - larguras.slice(0, -1).reduce(function (a, b) { return a + b; }, 0);
      var rows = [];
      if (t.head.length) {
        rows.push(new D.TableRow({ tableHeader: true, children: t.head.map(function (c, i) {
          return cel(tx(c, { size: 18, bold: true, color: 'FFFFFF', caps: true, track: 10, after: 0 }),
            { w: larguras[i], fill: TX });
        }) }));
      }
      t.rows.forEach(function (r, ri) {
        if (r.decisao) {
          rows.push(new D.TableRow({ children: [cel(
            rotulado('Decisão da revisão:', r.decisao, { size: 18, color: 'FFFFFF', after: 0 }),
            { w: LARG, span: t.cols, fill: TX })] }));
          return;
        }
        rows.push(new D.TableRow({ children: r.cells.map(function (c, i) {
          return cel(tx(c, { size: 19, after: 0, bold: i === 0 && t.cols === 2 && t.mono }),
            { w: larguras[i], fill: ri % 2 ? S1 : undefined });
        }) }));
      });
      return new D.Table({ width: { size: LARG, type: WT.DXA }, columnWidths: larguras,
        layout: TL.FIXED, rows: rows,
        borders: { top: li(), bottom: li(), left: li(), right: li(),
          insideHorizontal: li(), insideVertical: li() } });
    }
    dados.secoes.filter(function (s) { return s.num === '01'; }).forEach(function (sec) {
      filhos.push(new P({ children: [new D.PageBreak()] }));
      filhos.push(new D.Table({ width: { size: LARG, type: WT.DXA },
        columnWidths: [700, LARG - 700], layout: TL.FIXED, borders: nada,
        rows: [new D.TableRow({ children: [
          cel(tx(sec.num, { size: 24, bold: true, color: 'FFFFFF', align: AL.CENTER, after: 0 }),
            { w: 700, fill: TX, vAlign: VA.CENTER }),
          cel(new P({ heading: H.HEADING_1, outlineLevel: 0, spacing: { after: 0 },
            children: [new T({ text: sec.titulo, font: FONT, size: 28, bold: true, color: TX })] }),
            { w: LARG - 700, vAlign: VA.CENTER })] })] }));
      filhos.push(tx('', { after: 200 }));
      sec.itens.forEach(function (it) {
        if (it.tipo === 'tabela') { filhos.push(tabela(it)); filhos.push(tx('', { after: 200 })); }
        else if (it.tipo === 'titulo') {
          filhos.push(new P({ heading: H.HEADING_2, outlineLevel: 1, spacing: { before: 240, after: 100 },
            children: [new T({ text: it.texto, font: FONT, size: 24, bold: true, color: TX })] }));
        } else if (it.tipo === 'info') { filhos.push(tx(it.texto, { size: 17, color: MUT, after: 160 })); }
        else if (it.tipo === 'arvore') { it.nos.forEach(no); }
        else if (it.tipo === 'call') {
          filhos.push(tx(it.rotulo, { size: 14, color: MUT, caps: true, track: 30, after: 60,
            indent: { left: 220 }, fill: S1 }));
          filhos.push(tx(it.texto, { fill: S1, indent: { left: 220 }, after: 200,
            border: { left: { style: BS.SINGLE, size: 18, color: TX, space: 8 } } }));
        } else if (it.tipo === 'figura') {
          var png = figuras.shift();
          if (png) {
            var lw = 620, lh = Math.round(lw * png.h / png.w);
            filhos.push(new P({ alignment: AL.CENTER, spacing: { before: 120, after: 80 },
              children: [new D.ImageRun({ data: png.data, type: 'png',
                transformation: { width: lw, height: lh } })] }));
          }
          if (it.legenda) filhos.push(tx(it.legenda, { size: 17, color: MUT, align: AL.CENTER, after: 200 }));
        } else if (it.texto) { filhos.push(tx(it.texto)); }
      });
    });
    return new D.Document({
      creator: 'Ever i9', title: CFG.docId, description: dados.titulo,
      styles: { default: { document: { run: { font: FONT, size: 20, color: TX } },
        heading1: { run: { font: FONT, size: 28, bold: true, color: TX } },
        heading2: { run: { font: FONT, size: 24, bold: true, color: TX } },
        heading3: { run: { font: FONT, size: 22, bold: true, color: TX } },
        heading4: { run: { font: FONT, size: 21, bold: true, color: TX } },
        heading5: { run: { font: FONT, size: 20, bold: true, color: TX } } } },
      sections: [{ properties: { page: { size: { width: PAGE_W, height: 16838 },
          margin: { top: MG, bottom: MG, left: MG, right: MG } } },
        footers: { default: new D.Footer({ children: [new P({ border: { top: li(S2) },
          spacing: { before: 80 },
          children: [new T({ text: dados.rodape, font: FONT, size: 15, color: MUT }),
                     new T({ text: '    ·    página ', font: FONT, size: 15, color: MUT }),
                     new T({ children: [D.PageNumber.CURRENT], font: FONT, size: 15, color: MUT })] })] }) },
        children: filhos }]
    });
  }

  // ---- tema e estilo próprios: sem eles o Word resolve cores pelo tema de quem abre
  var TEMA = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Ever i9\"><a:themeElements><a:clrScheme name=\"Ever i9\"><a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1><a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1><a:dk2><a:srgbClr val=\"0D0D0D\"/></a:dk2><a:lt2><a:srgbClr val=\"F2F3F5\"/></a:lt2><a:accent1><a:srgbClr val=\"0D0D0D\"/></a:accent1><a:accent2><a:srgbClr val=\"3A3A3A\"/></a:accent2><a:accent3><a:srgbClr val=\"6B6B6B\"/></a:accent3><a:accent4><a:srgbClr val=\"9A9A9A\"/></a:accent4><a:accent5><a:srgbClr val=\"C9C9C9\"/></a:accent5><a:accent6><a:srgbClr val=\"E8E9EC\"/></a:accent6><a:hlink><a:srgbClr val=\"0D0D0D\"/></a:hlink><a:folHlink><a:srgbClr val=\"6B6B6B\"/></a:folHlink></a:clrScheme><a:fontScheme name=\"Ever i9\"><a:majorFont><a:latin typeface=\"Aptos\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:majorFont><a:minorFont><a:latin typeface=\"Aptos\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:minorFont></a:fontScheme><a:fmtScheme name=\"Ever i9\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w=\"6350\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln><a:ln w=\"12700\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln><a:ln w=\"19050\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>";
  var ESTILO_TABELA = "<w:style w:type=\"table\" w:styleId=\"EverI9Tabela\"><w:name w:val=\"Ever i9 Tabela\"/><w:uiPriority w:val=\"99\"/><w:qFormat/><w:tblPr><w:tblCellMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"0\" w:type=\"dxa\"/><w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"0\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr></w:style>";

  // ---- árvore recolhível: marca os títulos da modelagem como recolhidos no Word
  function recolher(blob) {
    return lib('jszip', 'vendor/jszip.min.js', 'JSZip').then(function (JSZip) {
      return JSZip.loadAsync(blob).then(function (zip) {
        return Promise.all([
          zip.file('word/document.xml').async('string'),
          zip.file('word/styles.xml').async('string'),
          zip.file('[Content_Types].xml').async('string'),
          zip.file('word/_rels/document.xml.rels').async('string')
        ]).then(function (partes) {
          var xml = partes[0], estilos = partes[1], tipos = partes[2], rels = partes[3];
          xml = xml.replace(/<w:pPr><w:pStyle w:val="Heading[45]"\/>[\s\S]*?<\/w:pPr>/g, function (b) {
            if (b.indexOf('w15:collapsed') >= 0) return b;
            return b.replace('</w:pPr>', '<w15:collapsed/></w:pPr>');
          });
          // a biblioteca escreve a borda de parágrafo fora da ordem que o Word exige
          xml = xml.replace(/<w:pBdr>([\s\S]*?)<\/w:pBdr>/g, function (todo, dentro) {
            var ordem = ['top', 'left', 'bottom', 'right', 'between', 'bar'], saida = '';
            ordem.forEach(function (lado) {
              var m = dentro.match(new RegExp('<w:' + lado + '\\b[^>]*/>'));
              if (m) saida += m[0];
            });
            return '<w:pBdr>' + (saida || dentro) + '</w:pBdr>';
          });
          // cada tabela declara o próprio estilo: sem isso o Word usa o estilo padrão de quem abre
          xml = xml.replace(/<w:tblPr>/g, '<w:tblPr><w:tblStyle w:val="EverI9Tabela"/>');
          zip.file('word/document.xml', xml);
          if (estilos.indexOf('EverI9Tabela') < 0) {
            zip.file('word/styles.xml', estilos.replace('</w:styles>', ESTILO_TABELA + '</w:styles>'));
          }
          zip.file('word/theme/theme1.xml', TEMA);
          if (tipos.indexOf('theme1.xml') < 0) {
            zip.file('[Content_Types].xml', tipos.replace('</Types>',
              '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'));
          }
          if (rels.indexOf('theme/theme1.xml') < 0) {
            zip.file('word/_rels/document.xml.rels', rels.replace('</Relationships>',
              '<Relationship Id="rIdTema" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>'));
          }
          return zip.generateAsync({ type: 'blob', compression: 'DEFLATE',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        });
      });
    }).catch(function () { return blob; });   // sem recolhimento, o documento continua válido
  }

  function gerarWord(stat) {
    stat('Montando o documento…');
    var dados = lerDocumento();
    var svgs = [];
    dados.secoes.forEach(function (s) {
      s.itens.forEach(function (i) { if (i.tipo === 'figura' && i.svg) svgs.push(i.svg); });
    });
    return lib('docx', 'vendor/docx.umd.js', 'docx').then(function (D) {
      return Promise.all(svgs.map(svgPng)).then(function (figuras) {
        var doc = montarWord(D, dados, figuras.filter(Boolean));
        return D.Packer.toBlob(doc);
      });
    }).then(function (blob) {
      stat('Preparando a árvore recolhível…');
      return recolher(blob);
    });
  }
  function salvarBlob(blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = CFG.fileBase + '.docx';
    a.click();
  }

  // ---- do trecho na pré-visualização direto para o comentário do item na página
  function nomeLimpo(el) {
    var c = el.cloneNode(true);
    all('.umseta, .umcom', c).forEach(function (x) { x.remove(); });
    return txt(c);
  }
  function acharNo(nome) {
    var alvo = null;
    all('details[data-clabel]').forEach(function (d) {
      if (alvo) return;
      var r = d.getAttribute('data-clabel');
      if (r && (nome === r || nome.indexOf(r) === 0 || r.indexOf(nome) === 0)) alvo = d;
    });
    return alvo;
  }
  function ligarComentario(titulo) {
    var det = acharNo(nomeLimpo(titulo));
    if (!det) return;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'umcom'; b.textContent = '✎ comentar';
    b.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      var trecho = String(window.getSelection ? window.getSelection().toString() : '').trim();
      abrirComentario(det, trecho);
    });
    titulo.appendChild(b);
  }
  function abrirComentario(det, trecho) {
    var modal = document.querySelector('.umodal');
    if (modal) modal.remove();
    var pai = det.parentNode;
    while (pai) {                                   // abre a árvore até o item
      if (pai.tagName === 'DETAILS') pai.open = true;
      pai = pai.parentNode;
    }
    det.open = true;
    var box = det.querySelector(':scope > .ubody > .cbox');
    var botao = det.querySelector(':scope > summary > .cbtn');
    if (botao) botao.click();
    if (box) {
      if (trecho && !box.textContent.trim()) {
        box.textContent = trecho;
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      box.classList.add('show');
      det.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () { box.focus(); }, 400);
    }
    voltarAoPreview = true;
    var st = document.getElementById('cStat');
    if (st) st.textContent = 'Edite o comentário e clique em Salvar: o documento e o Word são refeitos.';
  }
  var voltarAoPreview = false;
  // chamado pelo botão Salvar da página assim que a gravação termina
  window.__UC_POS_SALVAR__ = function () {
    if (!voltarAoPreview) return;
    voltarAoPreview = false;
    var stat = function (t) { var s = document.getElementById('cStat'); if (s) s.textContent = t; };
    setTimeout(function () { preverWord(stat); }, 400);
  };

  // ---- recolher/expandir na pré-visualização, como o documento abre no Word
  function montarArvorePreview(raiz) {
    var NIVEL = { umdocx_heading2: 2, umdocx_heading3: 3, umdocx_heading4: 4, umdocx_heading5: 5 };
    var itens = all('article > *', raiz).length ? all('article > *', raiz) : all('section > *', raiz);
    // a pré-visualização quebra em páginas: junta tudo numa sequência só
    var seq = [];
    all('section', raiz).forEach(function (sec) {
      all(':scope > article > *, :scope > *', sec).forEach(function (x) {
        if (x.tagName === 'ARTICLE') { all(':scope > *', x).forEach(function (y) { seq.push(y); }); }
        else if (seq.indexOf(x) < 0) seq.push(x);
      });
    });
    var titulos = [];
    seq.forEach(function (el, i) {
      var n = NIVEL[el.className];
      if (n) titulos.push({ el: el, nivel: n, i: i });
    });
    if (!titulos.length) return;
    titulos.forEach(function (t, k) {
      var fim = seq.length;
      for (var j = k + 1; j < titulos.length; j++) {
        if (titulos[j].nivel <= t.nivel) { fim = titulos[j].i; break; }
      }
      t.filhos = seq.slice(t.i + 1, fim);
      if (!t.filhos.length) return;
      t.el.classList.add('umtit');
      var seta = document.createElement('span');
      seta.className = 'umseta';
      t.el.insertBefore(seta, t.el.firstChild);
      var fechado = t.nivel >= 4;            // grupos e atributos começam recolhidos
      var aplicar = function () {
        t.el.classList.toggle('umfech', fechado);
        t.filhos.forEach(function (f) { f.style.display = fechado ? 'none' : ''; });
      };
      t.el.style.cursor = 'pointer';
      t.el.addEventListener('click', function () { fechado = !fechado; aplicar(); });
      aplicar();
      ligarComentario(t.el);
    });
    var barra = document.createElement('div');
    barra.className = 'umarv';
    barra.innerHTML = '<button type="button" id="umExp">Expandir tudo</button>'
      + '<button type="button" id="umCol">Recolher tudo</button>'
      + '<span class="umdica">A árvore abre recolhida, como no Word. Clique nos títulos para expandir.</span>';
    raiz.parentNode.insertBefore(barra, raiz);
    var todos = function (abrir) {
      titulos.forEach(function (t) {
        if (!t.filhos || !t.filhos.length) return;
        t.el.classList.toggle('umfech', !abrir);
        t.filhos.forEach(function (f) { f.style.display = abrir ? '' : 'none'; });
      });
    };
    barra.querySelector('#umExp').onclick = function () { todos(true); };
    barra.querySelector('#umCol').onclick = function () { todos(false); };
  }

  // ---------------------------------------------------------------- pré-visualização
  // a biblioteca de leitura usa o mesmo nome global da de escrita: guardamos e devolvemos
  var PV = null;
  function libPreview() {
    if (PV) return Promise.resolve(PV);
    return lib('jszip', 'vendor/jszip.min.js', 'JSZip').then(function () {
      var escritor = window.docx;
      window.docx = undefined;
      return fetch('vendor/docx-preview.min.js').then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status); return r.text();
      }).then(function (codigo) {
        return new Promise(function (res, rej) {
          var sc = document.createElement('script');
          sc.src = URL.createObjectURL(new Blob([codigo], { type: 'application/javascript' }));
          sc.onload = function () {
            PV = window.docx;
            window.docx = escritor;                 // devolve o gerador ao lugar
            PV && PV.renderAsync ? res(PV) : rej(new Error('pré-visualização indisponível'));
          };
          sc.onerror = function () { window.docx = escritor; rej(new Error('pré-visualização')); };
          document.head.appendChild(sc);
        });
      });
    });
  }
  function preverWord(stat) {
    var fundoM = document.createElement('div'); fundoM.className = 'umodal';
    fundoM.innerHTML = '<div class="umbox"><div class="umtop"><b>' + CFG.fileBase + '.docx</b>'
      + '<span class="umsub">pré-visualização do documento</span>'
      + '<span class="umflex"></span>'
      + '<button type="button" class="umsec" id="umFechar">Fechar</button>'
      + '<button type="button" id="umBaixar">Baixar</button></div>'
      + '<div class="umbody"><div class="umload">Montando a pré-visualização…</div>'
      + '<div id="umDoc"></div></div>'
      + '<div class="umpe">Para alterar o conteúdo, comente no item e salve: o documento se atualiza e o '
      + 'Word sai com a decisão aplicada. Ajustes de redação também podem ser feitos no Word depois de baixar.'
      + '</div></div>';
    document.body.appendChild(fundoM);
    var fechar = function () { fundoM.remove(); document.removeEventListener('keydown', esc); };
    var esc = function (e) { if (e.key === 'Escape') fechar(); };
    document.addEventListener('keydown', esc);
    fundoM.addEventListener('click', function (e) { if (e.target === fundoM) fechar(); });
    fundoM.querySelector('#umFechar').onclick = fechar;
    var pronto = null;
    fundoM.querySelector('#umBaixar').onclick = function () {
      if (pronto) { salvarBlob(pronto); stat('Word salvo (' + CFG.fileBase + '.docx).'); fechar(); }
    };
    return gerarWord(stat).then(function (blob) {
      pronto = blob;
      return libPreview().then(function (pv) {
        return pv.renderAsync(blob, fundoM.querySelector('#umDoc'), null,
          { className: 'umdocx', inWrapper: true, ignoreWidth: false, breakPages: true,
            experimental: true, renderHeaders: true, renderFooters: true });
      });
    }).then(function () {
      var l = fundoM.querySelector('.umload'); if (l) l.remove();
      montarArvorePreview(fundoM.querySelector('#umDoc'));
      stat('Pré-visualização pronta. Revise e clique em Baixar.');
    }).catch(function (e) {
      var l = fundoM.querySelector('.umload');
      if (l) l.textContent = 'Não foi possível montar a pré-visualização (' + e.message + ').';
      stat('Falha na pré-visualização (' + e.message + ').');
    });
  }

  // ---------------------------------------------------------------- botões
  function montar() {
    var bar = document.querySelector('.cbar');
    if (!bar) return setTimeout(montar, 200);
    var stat = function (t) { var s = document.getElementById('cStat'); if (s) s.textContent = t; };
    var bHub = document.createElement('a');
    // endereço amigável do hub; local, segue o arquivo ao lado para o teste funcionar
    bHub.id = 'cHub'; bHub.className = 'sec';
    bHub.href = /^https?:$/.test(location.protocol) && !/^localhost|^127\./.test(location.hostname)
      ? 'https://everi9.albertobottaro.info/hub' : 'uc-hub.html';
    bHub.textContent = '← Hub';
    var bUp = document.createElement('button');
    bUp.id = 'cUpd'; bUp.className = 'sec'; bUp.type = 'button'; bUp.textContent = 'Atualizar documento';
    var bW = document.createElement('button');
    bW.id = 'cWord'; bW.type = 'button'; bW.textContent = 'Baixar Word';
    var alvo = document.getElementById('cStat');
    bar.insertBefore(bUp, alvo); bar.insertBefore(bW, alvo);
    bar.insertBefore(bHub, bar.firstChild);
    window.__UC_APLICAR__ = function () {
      return lerSalvos().then(function (j) { return aplicar(j); }).catch(function () { return 0; });
    };
    bUp.onclick = function () {
      stat('Lendo comentários salvos…');
      lerSalvos().then(function (j) {
        if (!j) { aplicar(null); stat('Nenhum comentário salvo nesta rodada.'); return; }
        var n = aplicar(j);
        if (!n) { stat('Nenhum comentário aplicável nesta rodada.'); return; }
        if (j.status === 'APLICADA') {
          stat('Documento atualizado com ' + n + ' definição(ões) da rodada ' + CFG.rodada + '.');
          return;
        }
        stat('Registrando a aplicação…');
        return marcarAplicada(CFG.rodada).then(function (r) {
          stat('Documento atualizado: ' + n + ' comentário(s) viraram definição do documento '
            + '(rodada ' + r.rodada + ' aplicada).');
        });
      }).catch(function (e) { stat('Não foi possível atualizar (' + e.message + ').'); });
    };
    bW.onclick = function () { preverWord(stat); };
    // aplica automaticamente o que já está salvo
    lerSalvos().then(function (j) { if (j) aplicar(j); }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', montar);
  else montar();
})();
