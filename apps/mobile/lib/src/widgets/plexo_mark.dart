// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Plexo Tesseract Frame mark — outer square + inner 45°-rotated square + four
// projection lines + center node. Mirrors `brand/plexo-symbol-on-dark.svg` and
// the web `PlexoMark` (48-unit brand space) so the mobile shell carries the
// same logo as the web app, Android launcher, and desktop tray.

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
      ..style = PaintingStyle.stroke;

    // Projection lines (drawn fainter, behind the squares).
    final proj = Paint()
      ..color = color.withValues(alpha: 0.5)
      ..strokeWidth = 0.75 * s
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    canvas.drawLine(p(8, 8), p(8, 24), proj);
    canvas.drawLine(p(40, 8), p(40, 24), proj);
    canvas.drawLine(p(8, 40), p(8, 24), proj);
    canvas.drawLine(p(40, 40), p(40, 24), proj);

    // Outer square.
    final square = Paint()
      ..color = color
      ..strokeWidth = 1.5 * s
      ..style = PaintingStyle.stroke;
    canvas.drawRect(
      Rect.fromLTRB(8 * s, 8 * s, 40 * s, 40 * s),
      square,
    );

    // Inner rotated square (a diamond through the edge midpoints).
    final inner = Path()
      ..moveTo(24 * s, 8 * s)
      ..lineTo(40 * s, 24 * s)
      ..lineTo(24 * s, 40 * s)
      ..lineTo(8 * s, 24 * s)
      ..close();
    canvas.drawPath(inner, square);

    // Center node.
    final node = Paint()
      ..color = color
      ..style = PaintingStyle.fill;
    canvas.drawCircle(p(24, 24), 2.5 * s, node);
  }

  @override
  bool shouldRepaint(_PlexoMarkPainter old) => old.color != color;
}
