# VI Template Serial ID Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace UUID template IDs with BIGSERIAL and show ID in three UI lists.

**Architecture:** DB migration 008 + update 003/005 for fresh installs; Rust types `String`→`i64`; static HTML/JS ID column.

**Tech Stack:** PostgreSQL, sqlx, Axum, vanilla JS

### Task 1: Migrations
- Update `003` / `005`; add `008_vi_serial_id.sql`; wire in `db.rs`

### Task 2: Store + API
- `ViTemplate.id: i64`, queue `vi_template_id: i64`, insert without client UUID
- Path/handlers/tests

### Task 3: UI + README
- Three tables show ID; README note
