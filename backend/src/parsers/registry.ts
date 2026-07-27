import type { ImportParserInfo } from '@portfolio/shared';
import { csvParser } from './csv.js';
import { inwestomatParser } from './inwestomat.js';
import type { ImportParser, ParserFileMeta } from './types.js';
import { xtbParser } from './xtb.js';

/**
 * Rejestr parserów importu.
 *
 * Dodanie kolejnego źródła sprowadza się do dopisania implementacji do tej
 * listy — warstwa importu, trasy API i frontend nie wymagają zmian.
 */
const PARSERS: ImportParser[] = [xtbParser, inwestomatParser, csvParser];

export function allParsers(): ImportParser[] {
  return [...PARSERS];
}

export function parserById(id: string): ImportParser | null {
  return PARSERS.find((p) => p.id === id) ?? null;
}

export function parserInfo(): ImportParserInfo[] {
  return PARSERS.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    extensions: [...p.extensions],
    requiresMapping: p.requiresMapping,
  }));
}

export interface DetectionResult {
  parser: ImportParser;
  confidence: number;
}

/** Wybiera parser o najwyższej pewności rozpoznania. */
export async function detectParser(buffer: Buffer, filename: string): Promise<DetectionResult | null> {
  const meta: ParserFileMeta = {
    filename,
    head: buffer.subarray(0, 4096).toString('utf8'),
    size: buffer.length,
  };

  const scored: DetectionResult[] = [];
  for (const parser of PARSERS) {
    try {
      const confidence = await parser.detect(meta, buffer);
      if (confidence > 0) scored.push({ parser, confidence });
    } catch {
      // Parser, który wywala się na rozpoznawaniu, po prostu nie kandyduje.
    }
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.confidence - a.confidence);
  return scored[0]!;
}
