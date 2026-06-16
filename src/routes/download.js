// src/routes/download.js — Gera .docx com tema Dark profissional
import express from 'express';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat,
  HeadingLevel, BorderStyle, WidthType, ShadingType, PageBreak,
  TabStopType, TabStopPosition, SimpleField
} from 'docx';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ── Paleta Dark ──
const BLACK = "0A0A0A", ACCENT = "E0E0E0", BODY_TEXT = "1A1A1A";
const GRAY_BG = "F0F0F0", WHITE = "FFFFFF", GRAY_LINE = "CCCCCC", ROW_ALT = "F7F7F7";

const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: GRAY_LINE };
const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
const noBorder = { style: BorderStyle.NONE, size: 0, color: WHITE };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

function spacer(h = 200) {
  return new Paragraph({ spacing: { before: h, after: 0 }, children: [] });
}

function bodyPara(text) {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    children: [new TextRun({ text, font: "Arial", size: 20, color: BODY_TEXT })]
  });
}

function sectionHeading(num, title) {
  return new Paragraph({
    spacing: { before: 360, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BLACK, space: 4 } },
    children: [
      new TextRun({ text: num + "  ", font: "Arial", size: 28, bold: true, color: "AAAAAA" }),
      new TextRun({ text: title, font: "Arial", size: 28, bold: true, color: BLACK }),
    ]
  });
}

function subHeading(title) {
  return new Paragraph({
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text: title, font: "Arial", size: 22, bold: true, color: BLACK })]
  });
}

function metaRow(label, value) {
  return new TableRow({
    children: [
      new TableCell({
        borders: { top: { style: BorderStyle.SINGLE, size: 1, color: "333333" }, bottom: noBorder, left: noBorder, right: noBorder },
        width: { size: 2800, type: WidthType.DXA },
        shading: { fill: BLACK, type: ShadingType.CLEAR },
        margins: { top: 120, bottom: 120, left: 0, right: 140 },
        children: [new Paragraph({ children: [new TextRun({ text: label, font: "Arial", size: 18, color: "888888", allCaps: true })] })]
      }),
      new TableCell({
        borders: { top: { style: BorderStyle.SINGLE, size: 1, color: "333333" }, bottom: noBorder, left: noBorder, right: noBorder },
        width: { size: 6560, type: WidthType.DXA },
        shading: { fill: BLACK, type: ShadingType.CLEAR },
        margins: { top: 120, bottom: 120, left: 0, right: 140 },
        children: [new Paragraph({ children: [new TextRun({ text: value, font: "Arial", size: 18, color: "FFFFFF", bold: true })] })]
      })
    ]
  });
}

// ── Parser de Markdown → docx elements ──
function parseMarkdown(content, tipo) {
  const lines = content.split("\n");
  const elements = [];
  let sectionNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Heading ## → sectionHeading
    if (line.startsWith("## ")) {
      sectionNum++;
      const num = String(sectionNum).padStart(2, "0");
      elements.push(sectionHeading(num, line.replace(/^##\s*\d*\.?\s*[-—]?\s*/, "")));
      continue;
    }

    // Heading ### → subHeading
    if (line.startsWith("### ")) {
      elements.push(subHeading(line.replace("### ", "")));
      continue;
    }

    // Table detection (| ... |)
    if (line.includes("|") && line.trim().startsWith("|")) {
      const tableLines = [];
      let j = i;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim().startsWith("|")) {
        tableLines.push(lines[j]);
        j++;
      }
      i = j - 1;

      // Parse table
      const rows = tableLines
        .filter(l => !l.match(/^\|[-\s|:]+\|$/)) // skip separator
        .map(l => l.split("|").filter(c => c.trim()).map(c => c.trim()));

      if (rows.length > 0) {
        const numCols = rows[0].length;
        const colWidth = Math.floor(9360 / numCols);
        const colWidths = Array(numCols).fill(colWidth);

        const headerRow = new TableRow({
          children: rows[0].map((cell, ci) => new TableCell({
            borders,
            width: { size: colWidths[ci], type: WidthType.DXA },
            shading: { fill: BLACK, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 140, right: 140 },
            children: [new Paragraph({ children: [new TextRun({ text: cell, bold: true, color: WHITE, font: "Arial", size: 18, allCaps: true })] })]
          }))
        });

        const dataRows = rows.slice(1).map((row, ri) =>
          new TableRow({
            children: row.map((cell, ci) => new TableCell({
              borders,
              width: { size: colWidths[ci] || colWidth, type: WidthType.DXA },
              shading: ri % 2 === 1 ? { fill: ROW_ALT, type: ShadingType.CLEAR } : undefined,
              margins: { top: 100, bottom: 100, left: 140, right: 140 },
              children: [new Paragraph({ children: [new TextRun({ text: cell || "", font: "Arial", size: 18, color: BODY_TEXT })] })]
            }))
          })
        );

        elements.push(new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: colWidths,
          rows: [headerRow, ...dataRows]
        }));
        elements.push(spacer(100));
      }
      continue;
    }

    // Bold lines → bodyPara with bold
    if (line.startsWith("**") && line.endsWith("**")) {
      elements.push(new Paragraph({
        spacing: { before: 80, after: 80 },
        children: [new TextRun({ text: line.replace(/\*\*/g, ""), font: "Arial", size: 20, bold: true, color: BODY_TEXT })]
      }));
      continue;
    }

    // Bullet points
    if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        children: [
          new TextRun({ text: "\u2022  ", font: "Arial", size: 20, color: "AAAAAA" }),
          new TextRun({ text: line.replace(/^[-*]\s/, "").replace(/\*\*(.+?)\*\*/g, "$1"), font: "Arial", size: 20, color: BODY_TEXT })
        ]
      }));
      continue;
    }

    // Numbered items
    const numMatch = line.match(/^(\d+)\.\s(.+)/);
    if (numMatch) {
      elements.push(new Paragraph({
        spacing: { before: 40, after: 40 },
        children: [
          new TextRun({ text: numMatch[1] + ".  ", font: "Arial", size: 20, color: "AAAAAA", bold: true }),
          new TextRun({ text: numMatch[2].replace(/\*\*(.+?)\*\*/g, "$1"), font: "Arial", size: 20, color: BODY_TEXT })
        ]
      }));
      continue;
    }

    // Code blocks (skip)
    if (line.startsWith("```")) {
      while (i + 1 < lines.length && !lines[i + 1].startsWith("```")) {
        elements.push(new Paragraph({
          spacing: { before: 20, after: 20 },
          shading: { fill: "F5F5F5", type: ShadingType.CLEAR },
          children: [new TextRun({ text: lines[++i], font: "Courier New", size: 18, color: "333333" })]
        }));
      }
      i++; // skip closing ```
      continue;
    }

    // Empty line
    if (!line.trim()) {
      elements.push(spacer(60));
      continue;
    }

    // Regular text
    // Handle inline bold
    const parts = line.split(/\*\*(.+?)\*\*/g);
    if (parts.length > 1) {
      const runs = parts.map((part, pi) =>
        new TextRun({ text: part, font: "Arial", size: 20, bold: pi % 2 === 1, color: BODY_TEXT })
      );
      elements.push(new Paragraph({ spacing: { before: 80, after: 80 }, children: runs }));
    } else {
      elements.push(bodyPara(line));
    }
  }

  return elements;
}

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { content, type, title } = req.body;
    if (!content) return res.status(400).json({ error: 'content obrigatorio' });

    const filename = title || type || 'Documento';
    const tipoLabels = { spec: 'ESPECIFICACAO TECNICA', hf: 'HISTORIA FUNCIONAL', ata: 'ATA DE REUNIAO' };
    const tipoLabel = tipoLabels[type] || 'DOCUMENTO';
    const date = new Date().toLocaleDateString('pt-BR');

    const bodyElements = parseMarkdown(content, type);

    const doc = new Document({
      styles: {
        default: { document: { run: { font: "Arial", size: 20 } } },
      },
      sections: [
        // ═══ CAPA ═══
        {
          properties: {
            page: { size: { width: 12240, height: 15840 }, margin: { top: 0, right: 0, bottom: 0, left: 0 } }
          },
          children: [
            new Table({
              width: { size: 12240, type: WidthType.DXA },
              columnWidths: [12240],
              rows: [new TableRow({
                children: [new TableCell({
                  borders: noBorders,
                  width: { size: 12240, type: WidthType.DXA },
                  shading: { fill: BLACK, type: ShadingType.CLEAR },
                  margins: { top: 4000, bottom: 600, left: 1440, right: 1440 },
                  children: [
                    new Paragraph({ spacing: { after: 200 }, children: [
                      new TextRun({ text: "EVERI9 / SPEC AI", font: "Arial", size: 18, color: "888888", allCaps: true })
                    ]}),
                    new Paragraph({ spacing: { after: 300 }, children: [
                      new TextRun({ text: tipoLabel, font: "Arial", size: 56, bold: true, color: "FFFFFF" })
                    ]}),
                    new Paragraph({ spacing: { after: 600 }, children: [
                      new TextRun({ text: filename.replace(/_/g, " "), font: "Arial", size: 24, color: ACCENT })
                    ]}),
                    spacer(400),
                    new Table({
                      width: { size: 9360, type: WidthType.DXA },
                      columnWidths: [2800, 6560],
                      rows: [
                        metaRow("DOCUMENTO", filename),
                        metaRow("TIPO", tipoLabel),
                        metaRow("DATA", date),
                        metaRow("GERADO POR", "Ever i9 — Spec AI Platform"),
                      ]
                    })
                  ]
                })]
              })]
            })
          ]
        },
        // ═══ CORPO ═══
        {
          properties: {
            page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }
          },
          headers: {
            default: new Header({
              children: [new Paragraph({
                border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BLACK, space: 4 } },
                tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
                children: [
                  new TextRun({ text: "EVERI9", font: "Arial", size: 16, color: "888888" }),
                  new TextRun({ text: " / ", font: "Arial", size: 16, color: "888888" }),
                  new TextRun({ text: tipoLabel, font: "Arial", size: 16, color: BLACK, bold: true }),
                ]
              })]
            })
          },
          footers: {
            default: new Footer({
              children: [new Paragraph({
                border: { top: { style: BorderStyle.SINGLE, size: 4, color: BLACK, space: 4 } },
                tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
                children: [
                  new TextRun({ text: "Confidencial — Ever i9", font: "Arial", size: 16, color: "888888" }),
                  new TextRun({ children: ["\t"], font: "Arial", size: 16 }),
                  new SimpleField("PAGE")
                ]
              })]
            })
          },
          children: bodyElements,
        }
      ]
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Erro ao gerar documento: ' + err.message });
  }
});


// ═══ Função exportável para gerar .docx a partir de markdown ═══
export async function generateDocxBuffer(content, type, title) {
  const filename = title || type || 'Documento';
  const tipoLabels = { spec: 'ESPECIFICACAO TECNICA', hf: 'HISTORIA FUNCIONAL', ata: 'ATA DE REUNIAO', runbook: 'RUNBOOK DE IMPLEMENTACAO', spec_document: 'ESPECIFICACAO TECNICA', hf_document: 'HISTORIA FUNCIONAL', manifest_json: 'MANIFEST JSON' };
  const tipoLabel = tipoLabels[type] || 'DOCUMENTO';
  const date = new Date().toLocaleDateString('pt-BR');
  const bodyElements = parseMarkdown(content, type);

  const doc = new Document({
    styles: { default: { document: { run: { font: "Arial", size: 20 } } } },
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 0, right: 0, bottom: 0, left: 0 } } },
        children: [
          new Table({
            width: { size: 12240, type: WidthType.DXA }, columnWidths: [12240],
            rows: [new TableRow({ children: [new TableCell({
              borders: noBorders, width: { size: 12240, type: WidthType.DXA },
              shading: { fill: BLACK, type: ShadingType.CLEAR },
              margins: { top: 4000, bottom: 600, left: 1440, right: 1440 },
              children: [
                new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "EVERI9 / SQUAD AGENTES SF", font: "Arial", size: 18, color: "888888", allCaps: true })] }),
                new Paragraph({ spacing: { after: 300 }, children: [new TextRun({ text: tipoLabel, font: "Arial", size: 56, bold: true, color: "FFFFFF" })] }),
                new Paragraph({ spacing: { after: 600 }, children: [new TextRun({ text: filename.replace(/_/g, " "), font: "Arial", size: 24, color: ACCENT })] }),
                spacer(400),
                new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: [2800, 6560],
                  rows: [metaRow("DOCUMENTO", filename), metaRow("TIPO", tipoLabel), metaRow("DATA", date), metaRow("GERADO POR", "Ever i9 — Squad Agentes SF")] })
              ]
            })] })]
          })
        ]
      },
      {
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
        headers: { default: new Header({ children: [new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BLACK, space: 4 } },
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          children: [new TextRun({ text: "EVERI9", font: "Arial", size: 16, color: "888888" }), new TextRun({ text: " / ", font: "Arial", size: 16, color: "888888" }), new TextRun({ text: tipoLabel, font: "Arial", size: 16, color: BLACK, bold: true })]
        })] }) },
        footers: { default: new Footer({ children: [new Paragraph({
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: BLACK, space: 4 } },
          tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
          children: [new TextRun({ text: "Confidencial — Ever i9 Squad", font: "Arial", size: 16, color: "888888" }), new TextRun({ children: ["\t"], font: "Arial", size: 16 }), new SimpleField("PAGE")]
        })] }) },
        children: bodyElements,
      }
    ]
  });

  return Packer.toBuffer(doc);
}

export default router;
