// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Plexo Delta-Frame mark — open triangle with a gap in the base and three dots
// at the vertices. Mirrors the web `PlexoMark` SVG (48-unit brand space) so the
// mobile shell carries the same logo as the web app, launcher, and desktop tray.

import "package:flutter/material.dart";

import "../theme/tokens.dart";

class PlexoMark extends StatelessWidget {
  const PlexoMark({super.key, this.size = 32, this.color = PlexoColor.accent});

  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _PlexoMarkPainter(color)),
    );
  }
}

class _PlexoMarkPainter extends CustomPainter {
  _PlexoMarkPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    // Brand geometry in a 48-unit square.
    const double brand = 48;
    final double s = size.width / brand;
    Offset p(double x, double y) => Offset(x * s, y * s);

    final stroke = Paint()
      ..color = color
      ..strokeWidth = 2 * s
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;

    final edges = <List<Offset>>[
      [p(24, 10), p(12, 34)],
      [p(24, 10), p(36, 34)],
      [p(12, 34), p(20, 34)],
      [p(28, 34), p(36, 34)],
    ];
    for (final e in edges) {
      canvas.drawLine(e[0], e[1], stroke);
    }

    final dot = Paint()..color = color..style = PaintingStyle.fill;
    for (final c in [p(24, 10), p(12, 34), p(36, 34)]) {
      canvas.drawCircle(c, 3 * s, dot);
    }
  }

  @override
  bool shouldRepaint(_PlexoMarkPainter old) => old.color != color;
}
