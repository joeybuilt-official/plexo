// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

package httpauth

import "context"

func contextWithAppID(ctx context.Context, appID string) context.Context {
	return context.WithValue(ctx, appIDKey, appID)
}
