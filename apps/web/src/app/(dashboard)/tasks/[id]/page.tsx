// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'

export default function TaskDetailPage({ params }: { params: { id: string } }) {
    redirect(`/app/tasks/${params.id}`)
}
