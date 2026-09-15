// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Plexo Delta-Frame mark — closed triangle (no base gap) with three
// differently-colored vertex dots (accent blue / signal green / amber).
// Mirrors the web `PlexoMark` SVG (48-unit brand space) so the mobile shell
// carries the same logo as the web app, launcher, and desktop tray.

import "package:flutter/material.dart";

import "../theme/tokens.dart";

class PlexoMark extends StatelessWidget {
  const PlexoMark({super.key, this.size = 32, this.color = PlexoColor.textPrimary});

  /// Edge color; the vertex dots keep their own brand colors.
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

    // Closed triangle outline.
    final edge = Paint()
      ..color = color
      ..strokeWidth = 2 * s
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;
    final path = Path()
      ..moveTo(24 * s, 10 * s)
      ..lineTo(36 * s, 34 * s)
      ..lineTo(12 * s, 34 * s)
      ..close();
    canvas.drawPath(path, edge);

    // Vertex dots — distinct brand colors.
    final dotColors = <Color>[
      PlexoColor.accent,
      PlexoColor.signalGreen,
      PlexoColor.amber,
    ];
    final points = <Offset>[p(24, 10), p(12, 34), p(36, 34)];
    for (var i = 0; i < points.length; i++) {
      final dot = Paint()
        ..color = dotColors[i]
        ..style = PaintingStyle.fill;
      canvas.drawCircle(points[i], 3 * s, dot);
    }
  }

  @override
  bool shouldRepaint(_PlexoMarkPainter old) => old.color != color;
}
