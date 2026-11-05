import type { CefrLevel, LanguagePack, Persona } from '../packages/engine/src/types.ts';
import { german, jonas } from './de/index.ts';
import { english, tom } from './en/index.ts';

export interface Partner {
  id: string;
  pack: LanguagePack;
  persona: Persona;
  /** The language being practised, in English, for the screen. */
  language: string;
  tagline: string;
  levels: { level: CefrLevel; label: string }[];
  defaultLevel: CefrLevel;
  speech: { whisperLanguage: string; ttsLanguage: string; voice: string };
}

export const partners: Partner[] = [
  {
    id: 'jonas',
    pack: german,
    persona: jonas,
    language: 'German',
    tagline: 'A baker from Leipzig, for learners from beginner to good',
    levels: [
      { level: 'A1', label: 'Beginner (A1)' },
      { level: 'A2', label: 'Basic (A2)' },
      { level: 'B1', label: 'Intermediate (B1)' },
      { level: 'B2', label: 'Good (B2)' },
    ],
    defaultLevel: 'A2',
    speech: { whisperLanguage: 'de', ttsLanguage: 'german', voice: 'juergen' },
  },
  {
    id: 'tom',
    pack: english,
    persona: tom,
    language: 'English',
    tagline: 'A teacher from Nottingham, for confident practice at B2 and C1',
    levels: [
      { level: 'B2', label: 'Upper intermediate (B2)' },
      { level: 'C1', label: 'Advanced (C1)' },
    ],
    defaultLevel: 'B2',
    speech: { whisperLanguage: 'en', ttsLanguage: 'english', voice: 'paul' },
  },
];

export function partnerById(id: string | undefined): Partner | undefined {
  return partners.find((partner) => partner.id === id);
}
