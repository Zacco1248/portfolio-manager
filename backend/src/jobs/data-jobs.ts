import type { ScheduleFn } from './index.js';

/**
 * Rejestracja zadań operujących na danych (ceny, kursy, snapshoty, newsy,
 * alerty). Wypełniane w kolejnych etapach — plik istnieje od początku, żeby
 * harmonogram miał jeden punkt rozszerzania.
 */
export function registerDataJobs(_schedule: ScheduleFn): void {
  // Etap 2: ceny i kursy NBP
  // Etap 3: dzienny snapshot portfela
  // Etap 5: kontrola alertów
  // Etap 6: pobieranie i analiza newsów
}
