'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import type JSZip from 'jszip';
import type { ArtifactRecord, ArtifactVersion } from '@/lib/artifacts';

interface ArtifactPreviewProps {
  artifact: ArtifactRecord;
  version: ArtifactVersion;
  onReady?: (report: Record<string, unknown>) => void;
}

interface SlidePreview { number: number; text: string }
interface CellPreview { reference: string; value: string }
interface RowPreview { number: number; cells: CellPreview[] }
interface SheetPreview { name: string; rows: RowPreview[] }

const MAX_ZIP_ENTRIES = 5_000;
const MAX_INFLATED_BYTES = 100 * 1024 * 1024;

function parseXml(value: string): Document {
  if (/<!DOCTYPE/i.test(value)) throw new Error('Document XML declarations are not supported');
  const document = new DOMParser().parseFromString(value, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('Document contains invalid XML');
  return document;
}

function xmlText(value: string): string {
  return Array.from(parseXml(value).querySelectorAll('t')).map((node) => node.textContent || '').join(' ');
}

function assertBoundedZip(zip: JSZip): void {
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`Office document exceeds ${MAX_ZIP_ENTRIES} ZIP entries`);
  const inflated = entries.reduce((total, entry) => {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0;
    return total + size;
  }, 0);
  if (inflated > MAX_INFLATED_BYTES) throw new Error('Office document expands beyond the safe preview limit');
}

function cellValue(cell: Element, shared: string[]): string {
  const type = cell.getAttribute('t');
  if (type === 'inlineStr') return Array.from(cell.querySelectorAll('is t')).map((part) => part.textContent || '').join('');
  const raw = cell.querySelector('v')?.textContent || '';
  if (type === 's') return shared[Number(raw)] || '';
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;
}

export function ArtifactPreview({ artifact, version, onReady }: ArtifactPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [directReady, setDirectReady] = useState(false);
  const [text, setText] = useState('');
  const [slides, setSlides] = useState<SlidePreview[]>([]);
  const [sheets, setSheets] = useState<SheetPreview[]>([]);
  const rawUrl = `/api/artifacts/${encodeURIComponent(artifact.id)}/versions/${encodeURIComponent(version.id)}/raw`;

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timer = window.setTimeout(async () => {
      try {
        if (['html', 'pdf', 'image'].includes(artifact.kind)) {
          const response = await fetch(rawUrl, { method: 'HEAD', cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error('Artifact bytes could not be loaded');
          if (!disposed) setDirectReady(true);
          return;
        }
        const response = await fetch(rawUrl, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Artifact bytes could not be loaded');
        const bytes = await response.arrayBuffer();
        if (disposed) return;
        if (artifact.kind === 'word') {
          const { renderAsync } = await import('docx-preview');
          if (disposed || !containerRef.current) return;
          containerRef.current.replaceChildren();
          await renderAsync(bytes, containerRef.current, undefined, { inWrapper: true, breakPages: true, renderHeaders: true, renderFooters: true });
          if (!disposed) onReady?.({ renderer: 'docx-preview', rendered: true, bytes: version.bytes });
          return;
        }
        if (artifact.kind === 'excel' || artifact.kind === 'powerpoint') {
          const JSZip = (await import('jszip')).default;
          const zip = await JSZip.loadAsync(bytes);
          assertBoundedZip(zip);
          if (artifact.kind === 'powerpoint') {
            const names = Object.keys(zip.files)
              .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
              .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
            const values = await Promise.all(names.slice(0, 500).map(async (name) => ({
              number: Number(name.match(/slide(\d+)/)?.[1]) || 0,
              text: xmlText(await zip.file(name)!.async('text')).slice(0, 100_000),
            })));
            if (!disposed) {
              setSlides(values);
              onReady?.({
                renderer: 'pptx-xml-preview',
                rendered: true,
                visualVerificationEligible: false,
                previewFidelity: 'structural-text-only',
                slides: values.length,
                bytes: version.bytes,
              });
            }
            return;
          }
          const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('text');
          const shared = sharedXml
            ? Array.from(parseXml(sharedXml).querySelectorAll('si')).map((node) => Array.from(node.querySelectorAll('t')).map((part) => part.textContent || '').join(''))
            : [];
          const names = Object.keys(zip.files)
            .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
            .sort((a, b) => Number(a.match(/sheet(\d+)/)?.[1]) - Number(b.match(/sheet(\d+)/)?.[1]));
          if (!names.length) throw new Error('Workbook has no worksheet');
          const values = await Promise.all(names.slice(0, 20).map(async (name) => {
            const number = Number(name.match(/sheet(\d+)/)?.[1]) || 0;
            const document = parseXml(await zip.file(name)!.async('text'));
            const rows = Array.from(document.querySelectorAll('sheetData row')).slice(0, 500).map((row, rowIndex) => ({
              number: Number(row.getAttribute('r')) || rowIndex + 1,
              cells: Array.from(row.querySelectorAll(':scope > c')).slice(0, 100).map((cell, cellIndex) => ({
                reference: cell.getAttribute('r') || `cell-${cellIndex + 1}`,
                value: cellValue(cell, shared).slice(0, 10_000),
              })),
            }));
            return { name: `Sheet ${number}`, rows };
          }));
          if (!disposed) {
            setSheets(values);
            onReady?.({
              renderer: 'xlsx-xml-preview',
              rendered: true,
              visualVerificationEligible: false,
              previewFidelity: 'structural-cells-only',
              sheets: values.length,
              rows: values.reduce((count, sheet) => count + sheet.rows.length, 0),
              bytes: version.bytes,
            });
          }
          return;
        }
        const value = new TextDecoder().decode(bytes).slice(0, 1_000_000);
        if (!disposed) {
          setText(value);
          onReady?.({ renderer: 'text-preview', rendered: true, characters: value.length, bytes: version.bytes });
        }
      } catch (loadError) {
        if (controller.signal.aborted || disposed) return;
        const message = loadError instanceof Error ? loadError.message : 'Artifact rendering failed';
        setError(message);
        onReady?.({ rendered: false, error: message });
      }
    }, 0);
    return () => { disposed = true; window.clearTimeout(timer); controller.abort(); };
  }, [artifact.kind, onReady, rawUrl, version.bytes]);

  if (error) return <div className="p-6 text-sm text-error" role="alert">{error}</div>;
  if (['html', 'pdf', 'image'].includes(artifact.kind) && !directReady) return <div className="p-6 text-sm text-dim" role="status">Validating immutable preview…</div>;
  if (artifact.kind === 'html') return <iframe className="w-full min-h-[34rem] bg-white rounded" title={`${artifact.name} interactive preview`} src={rawUrl} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => onReady?.({ renderer: 'sandboxed-html', rendered: true, opaqueOrigin: true, bytes: version.bytes })} />;
  if (artifact.kind === 'pdf') return <iframe className="w-full min-h-[40rem] bg-white rounded" title={`${artifact.name} PDF preview`} src={rawUrl} sandbox="" referrerPolicy="no-referrer" onLoad={() => onReady?.({ renderer: 'browser-pdf', rendered: true, bytes: version.bytes })} />;
  if (artifact.kind === 'image') return <Image className="max-w-full max-h-[44rem] w-auto h-auto mx-auto object-contain" src={rawUrl} width={1600} height={1200} unoptimized alt={`${artifact.name} preview`} onLoad={(event) => onReady?.({ renderer: 'browser-image', rendered: true, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight, bytes: version.bytes })} />;
  if (artifact.kind === 'word') return <div ref={containerRef} className="artifact-docx-preview bg-white text-black p-4 min-h-64 overflow-auto" />;
  if (artifact.kind === 'powerpoint') return <div className="space-y-4">{slides.map((slide) => <section key={slide.number} className="aspect-video bg-white text-black rounded shadow p-8 flex flex-col" aria-label={`Slide ${slide.number}`}><div className="text-xs text-gray-500 mb-4">Slide {slide.number}</div><div className="text-xl whitespace-pre-wrap">{slide.text || '(No extractable text)'}</div></section>)}</div>;
  if (artifact.kind === 'excel') return <div className="space-y-5">{sheets.map((sheet) => <section key={sheet.name} aria-label={sheet.name}><h3 className="text-xs font-semibold mb-2">{sheet.name}</h3><div className="overflow-auto max-h-[32rem]"><table className="text-xs border-collapse bg-white text-black"><tbody>{sheet.rows.map((row) => <tr key={row.number}>{row.cells.map((cell) => <td key={cell.reference} className="border border-gray-300 px-2 py-1 whitespace-nowrap" title={cell.reference}>{cell.value}</td>)}</tr>)}</tbody></table></div></section>)}</div>;
  return <pre className="text-xs whitespace-pre-wrap break-words max-h-[40rem] overflow-auto">{text}</pre>;
}

export default ArtifactPreview;
