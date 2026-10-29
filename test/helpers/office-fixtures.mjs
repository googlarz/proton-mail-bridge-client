import { crc32, deflateRawSync } from "node:zlib";

// DOCX / XLSX / PPTX files and image-only PDFs built in code for the attachment-text tests: no binary fixtures in the
// repository. buildZip writes a plain ZIP; an entry can lie about its uncompressed size (declaredSize) to build a bomb.

export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const method = entry.store ? 0 : 8;
    const body = entry.store ? data : deflateRawSync(data);
    const name = Buffer.from(entry.name, "utf8");
    const size = entry.declaredSize ?? data.length;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export const para = (...runs) => `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${runs.join("")}</w:p>`;
export const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
export const tabRun = "<w:r><w:tab/></w:r>";

export function buildDocx(bodyXml, { documentName = "word/document.xml", prolog = XML } = {}) {
  return buildZip([
    { name: "[Content_Types].xml", data: `${XML}<Types/>` },
    { name: documentName, data: `${prolog}<w:document ${W}><w:body>${bodyXml}</w:body></w:document>` },
  ]);
}

function relationships(targets) {
  return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets
    .map(([id, target, external]) => `<Relationship Id="${id}" Type="x" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`)
    .join("")}</Relationships>`;
}

// sheets: [{ name, rows: [[cell, ...], ...], target? }]; a cell is { s: "text" } (shared string), { n: 4.5 }, { b: true }
// or { inline: "text" }.
export function buildXlsx(sheets, extraRels = []) {
  const shared = [];
  const cellXml = (cell, ref) => {
    if ("s" in cell) {
      shared.push(cell.s);
      return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
    }
    if ("n" in cell) return `<c r="${ref}"><f>SUM(A1)</f><v>${cell.n}</v></c>`;
    if ("b" in cell) return `<c r="${ref}" t="b"><v>${cell.b ? 1 : 0}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t>${cell.inline}</t></is></c>`;
  };
  const entries = [{ name: "[Content_Types].xml", data: `${XML}<Types/>` }];
  const workbookSheets = [];
  const rels = [];
  sheets.forEach((sheet, index) => {
    const id = `rId${index + 1}`;
    workbookSheets.push(`<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="${id}"/>`);
    const target = sheet.target ?? `worksheets/sheet${index + 1}.xml`;
    rels.push([id, target]);
    const rows = sheet.rows
      .map((cells, r) => `<row r="${r + 1}">${cells.map((cell, c) => cellXml(cell, `${String.fromCharCode(65 + c)}${r + 1}`)).join("")}</row>`)
      .join("");
    if (!sheet.target) entries.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: `${XML}<worksheet><sheetData>${rows}</sheetData></worksheet>` });
  });
  entries.push({ name: "xl/workbook.xml", data: `${XML}<workbook ${R}><sheets>${workbookSheets.join("")}</sheets></workbook>` });
  entries.push({ name: "xl/_rels/workbook.xml.rels", data: relationships([...rels, ...extraRels]) });
  entries.push({
    name: "xl/sharedStrings.xml",
    data: `${XML}<sst count="${shared.length}">${shared.map((text) => `<si><r><t>${text}</t></r><rPh><t>PHONETIC</t></rPh></si>`).join("")}</sst>`,
  });
  return buildZip(entries);
}

// slides: arrays of paragraphs; `order` lists the slide indexes in presentation order.
export function buildPptx(slides, order = slides.map((_, index) => index)) {
  const entries = [{ name: "[Content_Types].xml", data: `${XML}<Types/>` }];
  slides.forEach((paragraphs, index) => {
    const body = paragraphs.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join("");
    entries.push({ name: `ppt/slides/slide${index + 1}.xml`, data: `${XML}<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>` });
  });
  const ids = order.map((index, position) => `<p:sldId id="${256 + position}" r:id="rId${index + 10}"/>`).join("");
  entries.push({ name: "ppt/presentation.xml", data: `${XML}<p:presentation xmlns:p="p" ${R}><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>` });
  entries.push({ name: "ppt/_rels/presentation.xml.rels", data: relationships(slides.map((_, index) => [`rId${index + 10}`, `slides/slide${index + 1}.xml`])) });
  return buildZip(entries);
}

// A PDF whose pages each draw one image and no text, like a scan.
export function buildImagePdf(pageCount = 1, size = 32) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const pixels = Buffer.alloc(size * size * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 37) % 256;
  const image = add(`<< /Type /XObject /Subtype /Image /Width ${size} /Height ${size} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels.toString("latin1")}\nendstream`);
  const kids = [];
  for (let i = 0; i < pageCount; i += 1) {
    const stream = "q 200 0 0 200 100 400 cm /Im1 Do Q";
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${image} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
