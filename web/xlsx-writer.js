// ─────────────────────────────────────────────
// Zendesk Ticket Tracker — Minimal OOXML (.xlsx) Writer
// Dependency-free: hand-builds a valid (uncompressed/"store") ZIP containing
// just the workbook parts Excel needs. No external libraries required.
//
// Why this exists: the previous exporter wrote "SpreadsheetML 2003" XML but
// saved it with a .xls extension. Modern Excel detects that mismatch
// ("file format and extension don't match") and some mail/Office pipelines
// refuse to open it at all. A real .xlsx (OOXML) file has no such mismatch.
// ─────────────────────────────────────────────

(function (root) {
    'use strict';

    // ── CRC32 ──────────────────────────────────────────────────────────────
    const CRC_TABLE = (function () {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) {
            crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    // ── Byte helpers ───────────────────────────────────────────────────────
    function u16(v) {
        const b = new Uint8Array(2);
        new DataView(b.buffer).setUint16(0, v & 0xFFFF, true);
        return b;
    }

    function u32(v) {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, v >>> 0, true);
        return b;
    }

    function concatBytes(arrays) {
        let total = 0;
        for (const a of arrays) total += a.length;
        const out = new Uint8Array(total);
        let off = 0;
        for (const a of arrays) { out.set(a, off); off += a.length; }
        return out;
    }

    function toUtf8(str) {
        return new TextEncoder().encode(str);
    }

    function dosDateTime(date) {
        const year = Math.max(1980, date.getFullYear());
        const dosDate = (((year - 1980) & 0x7F) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
        const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
        return { dosDate, dosTime };
    }

    // ── ZIP container (store method — no compression, so no deflate needed) ─
    function buildZip(files) {
        const { dosDate, dosTime } = dosDateTime(new Date());
        let offset = 0;
        const localChunks = [];
        const centralChunks = [];

        files.forEach(file => {
            const nameBytes = toUtf8(file.name);
            const data = file.data;
            const crc = crc32(data);
            const size = data.length;

            const localHeader = concatBytes([
                u32(0x04034b50), u16(20), u16(0), u16(0),
                u16(dosTime), u16(dosDate),
                u32(crc), u32(size), u32(size),
                u16(nameBytes.length), u16(0)
            ]);
            localChunks.push(localHeader, nameBytes, data);

            const centralHeader = concatBytes([
                u32(0x02014b50), u16(20), u16(20), u16(0), u16(0),
                u16(dosTime), u16(dosDate),
                u32(crc), u32(size), u32(size),
                u16(nameBytes.length), u16(0), u16(0),
                u16(0), u16(0), u32(0), u32(offset)
            ]);
            centralChunks.push(centralHeader, nameBytes);

            offset += localHeader.length + nameBytes.length + data.length;
        });

        const centralDirBytes = concatBytes(centralChunks);
        const eocd = concatBytes([
            u32(0x06054b50), u16(0), u16(0),
            u16(files.length), u16(files.length),
            u32(centralDirBytes.length), u32(offset), u16(0)
        ]);

        return concatBytes([concatBytes(localChunks), centralDirBytes, eocd]);
    }

    // ── XML helpers ────────────────────────────────────────────────────────
    function escapeXml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function colName(idx) {
        let name = '';
        idx += 1;
        while (idx > 0) {
            const rem = (idx - 1) % 26;
            name = String.fromCharCode(65 + rem) + name;
            idx = Math.floor((idx - 1) / 26);
        }
        return name;
    }

    // ── Cell styles available to callers via XlsxWriter.STYLES ────────────
    const STYLES = { DATA: 0, HEADER: 1 };

    // Header fill is caller-supplied (see buildWorkbook's `options.headerColor`)
    // so a report's header can be colored by, e.g., how many tickets it holds.
    // Font color is picked for contrast against whatever fill comes in, using
    // a standard perceived-brightness weighting (not full WCAG luminance —
    // this only needs to pick black vs white, not measure a precise ratio).
    function hexToRgbTriplet(hex) {
        const h = String(hex).replace('#', '');
        const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
        const num = parseInt(full, 16);
        return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
    }

    function perceivedBrightness(hex) {
        const { r, g, b } = hexToRgbTriplet(hex);
        return (r * 299 + g * 587 + b * 114) / 1000;
    }

    function buildStylesXml(headerColorHex) {
        const fill = String(headerColorHex || '00B050').replace('#', '').toUpperCase();
        const fontRgb = perceivedBrightness(fill) > 150 ? '000000' : 'FFFFFF';
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/><color rgb="FF000000"/></font>
    <font><sz val="11"/><b/><name val="Calibri"/><color rgb="FF${fontRgb}"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF${fill}"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFA6A6A6"/></left>
      <right style="thin"><color rgb="FFA6A6A6"/></right>
      <top style="thin"><color rgb="FFA6A6A6"/></top>
      <bottom style="thin"><color rgb="FFA6A6A6"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;
    }

    function buildSheetXml(sheet) {
        let colsXml = '';
        if (sheet.cols && sheet.cols.length) {
            colsXml = '<cols>' + sheet.cols.map((c, i) =>
                `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`
            ).join('') + '</cols>';
        }

        let rowsXml = '';
        (sheet.rows || []).forEach((row, rIdx) => {
            const rNum = rIdx + 1;
            const heightAttr = row.height ? ` ht="${row.height}" customHeight="1"` : '';
            let cellsXml = '';
            (row.cells || []).forEach((cell, cIdx) => {
                const ref = `${colName(cIdx)}${rNum}`;
                const style = cell.style !== undefined ? cell.style : STYLES.DATA;
                const value = cell.value;
                if (value === undefined || value === null || value === '') {
                    cellsXml += `<c r="${ref}" s="${style}"/>`;
                } else {
                    const preserve = String(value).indexOf('\n') !== -1 ? ' xml:space="preserve"' : '';
                    cellsXml += `<c r="${ref}" s="${style}" t="inlineStr"><is><t${preserve}>${escapeXml(value)}</t></is></c>`;
                }
            });
            rowsXml += `<row r="${rNum}"${heightAttr}>${cellsXml}</row>`;
        });

        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
            `<dimension ref="A1"/>` +
            `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
            `<sheetFormatPr defaultRowHeight="15"/>` +
            colsXml +
            `<sheetData>${rowsXml}</sheetData>` +
            `</worksheet>`;
    }

    // ── Public API ─────────────────────────────────────────────────────────
    // sheets: [{ name, cols: [{width}], rows: [{height, cells: [{value, style}]}] }]
    // options: { headerColor } — hex string (e.g. "ED7D31" or "#ED7D31") for
    // the STYLES.HEADER fill; defaults to the original green if omitted.
    function buildWorkbook(sheets, options) {
        options = options || {};
        const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n  ')}
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

        const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

        const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheets.map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('\n    ')}
  </sheets>
</workbook>`;

        const stylesRelId = sheets.length + 1;
        const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n  ')}
  <Relationship Id="rId${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

        const files = [
            { name: '[Content_Types].xml', data: toUtf8(contentTypesXml) },
            { name: '_rels/.rels', data: toUtf8(rootRelsXml) },
            { name: 'xl/workbook.xml', data: toUtf8(workbookXml) },
            { name: 'xl/_rels/workbook.xml.rels', data: toUtf8(workbookRelsXml) },
            { name: 'xl/styles.xml', data: toUtf8(buildStylesXml(options.headerColor)) }
        ];
        sheets.forEach((s, i) => {
            files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: toUtf8(buildSheetXml(s)) });
        });

        return buildZip(files);
    }

    const XlsxWriter = { buildWorkbook, STYLES };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = XlsxWriter;
    } else {
        root.XlsxWriter = XlsxWriter;
    }
})(typeof window !== 'undefined' ? window : globalThis);
