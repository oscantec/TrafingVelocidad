-- ═══════════════════════════════════════════════════════════
--  Softrafing Velocidades — Esquema Supabase
--  Ejecutar UNA vez en:  Supabase → SQL Editor → New query
--  Es idempotente: se puede volver a correr sin romper nada.
-- ═══════════════════════════════════════════════════════════

-- ── Tabla: tracks ──────────────────────────────────────────
create table if not exists public.tracks (
  id          uuid primary key default gen_random_uuid(),
  local_id    text,                        -- id original del cliente (IndexedDB)
  name        text not null,
  start_time  timestamptz not null,
  end_time    timestamptz,
  distance    numeric default 0,           -- metros
  avg_speed   numeric default 0,           -- km/h
  point_count integer default 0,
  created_at  timestamptz default now(),
  unique (local_id)                        -- evita duplicados si se re-sincroniza
);

create index if not exists idx_tracks_start_time on public.tracks (start_time desc);

-- ── Tabla: gps_points ──────────────────────────────────────
create table if not exists public.gps_points (
  id         bigserial primary key,
  track_id   uuid not null references public.tracks(id) on delete cascade,
  lat        double precision not null,
  lng        double precision not null,
  speed      numeric,                      -- m/s como lo entrega la API de Geolocation
  accuracy   numeric,                      -- metros
  altitude   numeric,
  timestamp  timestamptz not null
);

create index if not exists idx_gps_points_track_id  on public.gps_points (track_id);
create index if not exists idx_gps_points_timestamp on public.gps_points (timestamp);

-- ── RLS: permitir lectura/escritura a cualquier cliente con la anon key ──
-- Adecuado para un entorno interno de NextCan. Ajustar si se añade auth.
alter table public.tracks     enable row level security;
alter table public.gps_points enable row level security;

drop policy if exists "anon read  tracks"     on public.tracks;
drop policy if exists "anon write tracks"     on public.tracks;
drop policy if exists "anon read  gps_points" on public.gps_points;
drop policy if exists "anon write gps_points" on public.gps_points;

create policy "anon read  tracks"
  on public.tracks     for select using (true);
create policy "anon write tracks"
  on public.tracks     for insert with check (true);
create policy "anon update tracks"
  on public.tracks     for update using (true) with check (true);

create policy "anon read  gps_points"
  on public.gps_points for select using (true);
create policy "anon write gps_points"
  on public.gps_points for insert with check (true);

-- ══════════════════════════════════════════════════════════
--  Tramificación — Corredor → Tramo → Puntos de control
-- ══════════════════════════════════════════════════════════

-- 1) Corredor (ej. "Avenida Caracas")
create table if not exists public.corridors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz default now()
);

-- 2) Tramo (ej. "Caracas — Norte") pertenece a un corredor
create table if not exists public.tramos (
  id           uuid primary key default gen_random_uuid(),
  corridor_id  uuid not null references public.corridors(id) on delete cascade,
  name         text not null,
  created_at   timestamptz default now(),
  unique (corridor_id, name)
);

create index if not exists idx_tramos_corridor on public.tramos (corridor_id);

-- 3) Puntos de control, ordenados dentro de un tramo
create table if not exists public.control_points (
  id         uuid primary key default gen_random_uuid(),
  tramo_id   uuid not null references public.tramos(id) on delete cascade,
  name       text not null,
  lat        double precision not null,
  lng        double precision not null,
  seq        integer default 0,
  created_at timestamptz default now()
);

create index if not exists idx_control_points_tramo on public.control_points (tramo_id, seq);

alter table public.corridors      enable row level security;
alter table public.tramos         enable row level security;
alter table public.control_points enable row level security;

drop policy if exists "anon all corridors"      on public.corridors;
drop policy if exists "anon all tramos"         on public.tramos;
drop policy if exists "anon all control_points" on public.control_points;

create policy "anon all corridors"
  on public.corridors for all using (true) with check (true);
create policy "anon all tramos"
  on public.tramos for all using (true) with check (true);
create policy "anon all control_points"
  on public.control_points for all using (true) with check (true);
