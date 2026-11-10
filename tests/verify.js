import assert from 'assert';
import fs from 'fs';
import path from 'path';
import app from '../src/app.js';

/**
 * Helper to construct a valid, standards-compliant PDF buffer with specified pages of text
 * so pdf-parse can extract text and page counts accurately.
 */
function buildValidPdfBuffer(pageTexts = []) {
  const objects = [];
  const addObject = (body) => {
    const id = objects.length + 1;
    objects.push({ id, body });
    return id;
  };

  // 1: Catalog, 2: Pages, 3: Font
  const catalogId = addObject(''); // placeholder
  const pagesId = addObject(''); // placeholder
  const fontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const pageIds = [];
  for (const pageText of pageTexts) {
    const lines = Array.isArray(pageText) ? pageText : [pageText];
    const streamLines = ['BT', '/F1 12 Tf', '50 750 Td', '14 TL'];
    for (const line of lines) {
      const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      if (escaped.trim().length > 0) {
        streamLines.push(`(${escaped}) Tj T*`);
      }
    }
    streamLines.push('ET');
    const streamContent = streamLines.join('\n');
    const contentId = addObject(
      `<< /Length ${Buffer.byteLength(streamContent, 'latin1')} >>\nstream\n${streamContent}\nendstream`
    );
    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1].body = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1].body = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

async function runTests() {
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const uploadsDir = path.resolve(process.cwd(), 'uploads');

  console.log(`\nStarting verification suite against ${baseUrl}...\n`);

  try {
    // 1. Health Check
    {
      const res = await fetch(`${baseUrl}/health`);
      const body = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.status, 'ok');
      console.log('✓ [1/9] Server health check passed');
    }

    // 2. Valid multi-page PDF upload via POST /api/documents
    let uploadedDocId;
    {
      const pdfBuffer = buildValidPdfBuffer([
        [
          'Amber Cloud Platform Security and Operations Handbook.',
          'All production database backups are executed automatically every 6 hours and retained for 35 days.',
          'The standard customer refund window is 30 calendar days from the date of invoice.',
          'Support tickets marked P1 Critical receive an initial engineering response within 15 minutes.',
        ],
        [
          'Employee Remote Work and Equipment Policy.',
          'Full-time engineers receive a $1,500 home office stipend every two years.',
          'VPN multi-factor authentication using hardware security keys is mandatory for production SSH access.',
        ],
      ]);

      const form = new FormData();
      form.append(
        'file',
        new Blob([pdfBuffer], { type: 'application/pdf' }),
        'amber-handbook.pdf'
      );

      const res = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        body: form,
      });
      const body = await res.json();

      assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(body)}`);
      assert.ok(body.documentId, 'Response must include documentId');
      assert.strictEqual(body.filename, 'amber-handbook.pdf');
      assert.strictEqual(body.totalPages, 2);
      assert.ok(body.totalChunks >= 1, 'totalChunks must be >= 1');

      uploadedDocId = body.documentId;
      console.log('✓ [2/9] Valid 2-page PDF upload & extraction passed:', body);
    }

    // 3. Verify chunk creation & vector storage via GET /api/documents/:documentId
    {
      const res = await fetch(`${baseUrl}/api/documents/${uploadedDocId}`);
      const body = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.documentId, uploadedDocId);
      assert.strictEqual(body.chunks.length, body.totalChunks);
      assert.ok(body.chunks[0].text.includes('Amber Cloud Platform'));
      assert.ok(body.chunks[0].embeddingDimensions > 0);
      console.log(
        `✓ [3/9] Verified chunk creation (${body.totalChunks} chunks, ${body.chunks[0].embeddingDimensions}-dim embeddings)`
      );
    }

    // 4. Error handling: Non-PDF file upload
    {
      const form = new FormData();
      form.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'notes.txt');

      const res = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        body: form,
      });
      const body = await res.json();
      assert.strictEqual(res.status, 400);
      assert.strictEqual(body.error.code, 'INVALID_FILE_TYPE');
      console.log('✓ [4/9] Non-PDF file rejection passed:', body.error.message);
    }

    // 5. Error handling: Empty 0-byte PDF & Blank (no-text) PDF
    {
      // 5a: 0-byte file with .pdf extension
      const formEmpty = new FormData();
      formEmpty.append('file', new Blob([Buffer.alloc(0)], { type: 'application/pdf' }), 'empty.pdf');
      const resEmpty = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        body: formEmpty,
      });
      const bodyEmpty = await resEmpty.json();
      assert.strictEqual(resEmpty.status, 400);
      assert.strictEqual(bodyEmpty.error.code, 'EMPTY_PDF_FILE');

      // 5b: Valid PDF with 1 blank page (no extractable text)
      const blankPdfBuffer = buildValidPdfBuffer(['']);
      const formBlank = new FormData();
      formBlank.append('file', new Blob([blankPdfBuffer], { type: 'application/pdf' }), 'blank.pdf');
      const resBlank = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        body: formBlank,
      });
      const bodyBlank = await resBlank.json();
      assert.strictEqual(resBlank.status, 400);
      assert.strictEqual(bodyBlank.error.code, 'EMPTY_PDF_TEXT');
      console.log('✓ [5/9] Empty (0-byte) & blank (no-text) PDF error handling passed');
    }

    // 6. Error handling: Corrupted PDF & >10MB file limit
    {
      // 6a: Corrupted PDF without %PDF header
      const formNoHeader = new FormData();
      formNoHeader.append(
        'file',
        new Blob([Buffer.from('NOT_A_VALID_PDF_BINARY_DATA')], { type: 'application/pdf' }),
        'corrupt1.pdf'
      );
      const resNoHeader = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        body: formNoHeader,
      });
      const bodyNoHeader = await resNoHeader.json();
      assert.strictEqual(resNoHeader.status, 400);
      assert.strictEqual(bodyNoHeader.error.code, 'CORRUPTED_PDF');

      // 6b: Corrupted PDF with %PDF-1.4 header but broken xref/body
      const formBrokenBody = new FormData();
      formBrokenBody.append(
        'file',
        new Blob([Buffer.from('%PDF-1.4\n1 0 obj\n<<CORRUPTED_STREAM>>\n%%EOF')], {
          type: 'application/pdf',
        }),
        'corrupt2.pdf'
      );
      const resBroken = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        body: formBrokenBody,
      });
      assert.ok([400, 422].includes(resBroken.status));

      // 6c: >10MB PDF limit check
      const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1024, 'a');
      const formOversized = new FormData();
      formOversized.append(
        'file',
        new Blob([oversizedBuffer], { type: 'application/pdf' }),
        'huge.pdf'
      );
      const resOversized = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        body: formOversized,
      });
      const bodyOversized = await resOversized.json();
      assert.strictEqual(resOversized.status, 413);
      assert.strictEqual(bodyOversized.error.code, 'FILE_TOO_LARGE');

      // Verify temporary uploaded files are completely deleted after both success and errors
      const remainingFiles = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
      assert.strictEqual(
        remainingFiles.length,
        0,
        `Expected 0 leftover temp files in uploads/, found: ${remainingFiles.join(', ')}`
      );
      console.log('✓ [6/9] Corrupted PDF, >10MB limit, and temp file cleanup verification passed');
    }

    // 7. Document Q&A against uploaded PDF (Answer is available)
    {
      const res = await fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: uploadedDocId,
          question: 'How often are production database backups executed and how long are they retained?',
        }),
      });
      const body = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.available, true);
      assert.ok(
        body.answer.toLowerCase().includes('6 hours') || body.answer.toLowerCase().includes('35 days'),
        `Expected answer to mention backup schedule, got: ${body.answer}`
      );
      console.log('✓ [7/9] Q&A on uploaded PDF (available answer) passed:', body.answer);
    }

    // 8. Document Q&A against uploaded PDF (Answer is NOT available)
    {
      const res = await fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: uploadedDocId,
          question: 'What is the cafeteria lunch menu on Fridays?',
        }),
      });
      const body = await res.json();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.available, false);
      assert.ok(
        body.answer.toLowerCase().includes('unavailable'),
        `Expected unavailable message, got: ${body.answer}`
      );
      console.log('✓ [8/9] Q&A on uploaded PDF (unavailable answer) passed:', body.answer);
    }

    // 9. Main Requirement: Direct Text Document + Question Q&A via POST /api/qa
    {
      const sampleTextDoc = `
        Project Helios Technical Specification:
        Helios is an autonomous solar drone designed for high-altitude atmospheric monitoring.
        It operates at a cruising altitude of 18,500 meters and has a maximum wingspan of 32 meters.
        The onboard lithium-sulfur battery array provides 14 hours of nighttime endurance.
      `;

      // 9a: Question with answer present in text document
      const resAvailable = await fetch(`${baseUrl}/api/qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document: sampleTextDoc,
          question: 'What is the cruising altitude and wingspan of Project Helios?',
        }),
      });
      const bodyAvailable = await resAvailable.json();
      assert.strictEqual(resAvailable.status, 200);
      assert.strictEqual(bodyAvailable.available, true);
      assert.ok(bodyAvailable.answer.includes('18,500'));

      // 9b: Question with answer NOT present in text document
      const resUnavailable = await fetch(`${baseUrl}/api/qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document: sampleTextDoc,
          question: 'Who is the chief financial officer of Project Helios?',
        }),
      });
      const bodyUnavailable = await resUnavailable.json();
      assert.strictEqual(resUnavailable.status, 200);
      assert.strictEqual(bodyUnavailable.available, false);
      assert.ok(bodyUnavailable.answer.toLowerCase().includes('unavailable'));

      console.log('✓ [9/9] Inline text document Q&A (available & unavailable cases) passed');
    }

    console.log('\nAll 9 end-to-end verification tests passed successfully!\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('\nVerification test failed:', err);
  process.exit(1);
});

