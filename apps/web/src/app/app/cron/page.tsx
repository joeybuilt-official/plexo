// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'

export default function CronRedirectPage(): never {
    redirect('/app/scheduling')
}
