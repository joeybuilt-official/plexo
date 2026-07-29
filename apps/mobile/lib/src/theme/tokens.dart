// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Plexo design tokens — mobile half. Values are ported VERBATIM from the web
// app's token block at apps/web/src/app/globals.css (the `@theme` block). Unlike
// Fonto (which seeds a Material tonal palette), Plexo's web look is a
// hand-picked "dark-zinc" palette, so we carry the exact hexes here to hold
// pixel parity with the web surfaces. Names mirror the CSS custom properties so
// a contributor can move web <-> mobile without re-learning vocab.

import "package:flutter/material.dart";

/// Raw surface/border/text/accent values from globals.css. Dark is the primary
/// theme (web defaults to dark; `.light` is an override).
abstract final class PlexoColor {
  // Surfaces (dark)
  static const Color canvas = Color(0xFF101520); // --color-canvas (page bg)
  static const Color surface1 = Color(0xFF161D2C); // cards, panels
  static const Color surface2 = Color(0xFF1D2640); // active/selected
  static const Color surface3 = Color(0xFF243052); // hover/focused
  static const Color surfaceCode = Color(0xFF0D0D0D); // terminal/code

  // Borders (dark)
  static const Color border = Color(0xFF253354); // structural
  static const Color borderSubtle = Color(0xFF1C2744); // dividers, grid

  // Text (dark)
  static const Color textPrimary = Color(0xFFE2E8F0); // body/foreground
  static const Color textSecondary = Color(0xFF8294B0); // labels, secondary
  static const Color textMuted = Color(0xFF576A88); // disabled, tertiary

  // Accent (brand blue)
  static const Color accent = Color(0xFF4DAAFC); // primary action
  static const Color accentDim = Color(0xFF3B8FDE); // hover/pressed
  static const Color accentHover = Color(0xFF6DBCFF); // secondary hover

  // Signal
  static const Color signalGreen = Color(0xFF10B981);
  static const Color signalRed = Color(0xFFF43F5E);
  static const Color amber = Color(0xFFF59E0B);

  // Light overrides
  static const Color lCanvas = Color(0xFFF7F8FC);
  static const Color lSurface1 = Color(0xFFF0F2F8);
  static const Color lSurface2 = Color(0xFFE4E8F2);
  static const Color lSurface3 = Color(0xFFD6DCE8);
  static const Color lTextPrimary = Color(0xFF101520);
  static const Color lTextSecondary = Color(0xFF364050);
  static const Color lTextMuted = Color(0xFF6B7280);
  static const Color lBorder = Color(0xFFD6DCE8);
  static const Color lAccent = Color(0xFF2B7DC0); // darker for WCAG AA on light
}

/// Corner radius. Joeybuilt house style caps at 4px (web `--radius-*` are all
/// 4px); we keep one near-square scale rather than Material's rounder defaults.
abstract final class PlexoRadius {
  static const double sm = 4;
  static const double md = 4;
  static const double lg = 6; // panels/sheets get a hair more
  static const double full = 9999;
}

/// 4px-base spacing scale, 1:1 with the web side. Pick the nearest token
/// instead of inline EdgeInsets magic numbers.
abstract final class PlexoSpace {
  static const double s1 = 4;
  static const double s2 = 8;
  static const double s3 = 12;
  static const double s4 = 16;
  static const double s5 = 20;
  static const double s6 = 24;
  static const double s8 = 32;
  static const double s10 = 40;
  static const double s12 = 48;
}

/// Dark ColorScheme built explicitly from the web hexes (NOT fromSeed) so the
/// app matches the web surfaces tone-for-tone.
const ColorScheme plexoDarkScheme = ColorScheme(
  brightness: Brightness.dark,
  primary: PlexoColor.accent,
  onPrimary: PlexoColor.canvas,
  primaryContainer: PlexoColor.surface2,
  onPrimaryContainer: PlexoColor.textPrimary,
  secondary: PlexoColor.textSecondary,
  onSecondary: PlexoColor.canvas,
  secondaryContainer: PlexoColor.surface2,
  onSecondaryContainer: PlexoColor.textPrimary,
  tertiary: PlexoColor.amber,
  onTertiary: PlexoColor.canvas,
  tertiaryContainer: PlexoColor.surface3,
  onTertiaryContainer: PlexoColor.textPrimary,
  error: PlexoColor.signalRed,
  onError: PlexoColor.canvas,
  errorContainer: Color(0xFF4A1620),
  onErrorContainer: Color(0xFFFFD9DE),
  surface: PlexoColor.canvas,
  onSurface: PlexoColor.textPrimary,
  surfaceDim: PlexoColor.canvas,
  surfaceBright: PlexoColor.surface3,
  surfaceContainerLowest: PlexoColor.surfaceCode,
  surfaceContainerLow: PlexoColor.surface1,
  surfaceContainer: PlexoColor.surface1,
  surfaceContainerHigh: PlexoColor.surface2,
  surfaceContainerHighest: PlexoColor.surface3,
  onSurfaceVariant: PlexoColor.textSecondary,
  outline: PlexoColor.border,
  outlineVariant: PlexoColor.borderSubtle,
  inverseSurface: PlexoColor.textPrimary,
  onInverseSurface: PlexoColor.canvas,
  inversePrimary: PlexoColor.accentDim,
  shadow: Color(0xFF000000),
  scrim: Color(0xFF000000),
);

/// Light ColorScheme override (web `.light`).
const ColorScheme plexoLightScheme = ColorScheme(
  brightness: Brightness.light,
  primary: PlexoColor.lAccent,
  onPrimary: Color(0xFFFFFFFF),
  primaryContainer: PlexoColor.lSurface2,
  onPrimaryContainer: PlexoColor.lTextPrimary,
  secondary: PlexoColor.lTextSecondary,
  onSecondary: Color(0xFFFFFFFF),
  secondaryContainer: PlexoColor.lSurface2,
  onSecondaryContainer: PlexoColor.lTextPrimary,
  tertiary: Color(0xFFB45309),
  onTertiary: Color(0xFFFFFFFF),
  tertiaryContainer: PlexoColor.lSurface3,
  onTertiaryContainer: PlexoColor.lTextPrimary,
  error: Color(0xFFD11A3A),
  onError: Color(0xFFFFFFFF),
  errorContainer: Color(0xFFFFD9DE),
  onErrorContainer: Color(0xFF410008),
  surface: PlexoColor.lCanvas,
  onSurface: PlexoColor.lTextPrimary,
  surfaceDim: PlexoColor.lSurface2,
  surfaceBright: Color(0xFFFFFFFF),
  surfaceContainerLowest: Color(0xFFFFFFFF),
  surfaceContainerLow: PlexoColor.lSurface1,
  surfaceContainer: PlexoColor.lSurface1,
  surfaceContainerHigh: PlexoColor.lSurface2,
  surfaceContainerHighest: PlexoColor.lSurface3,
  onSurfaceVariant: PlexoColor.lTextSecondary,
  outline: PlexoColor.lBorder,
  outlineVariant: PlexoColor.lSurface3,
  inverseSurface: PlexoColor.lTextPrimary,
  onInverseSurface: PlexoColor.lCanvas,
  inversePrimary: PlexoColor.accent,
  shadow: Color(0xFF000000),
  scrim: Color(0xFF000000),
);
