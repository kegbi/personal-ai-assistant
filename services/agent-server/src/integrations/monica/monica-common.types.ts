export interface MonicaPaginationLinks {
  first: string | null;
  last: string | null;
  prev: string | null;
  next: string | null;
}

export interface MonicaPaginationMeta {
  current_page: number;
  from: number | null;
  last_page: number;
  path: string;
  per_page: number | string;
  to: number | null;
  total: number;
}

export interface MonicaPaginatedResponse<TItem> {
  data: TItem[];
  links: MonicaPaginationLinks;
  meta: MonicaPaginationMeta;
}

export interface MonicaAccountReference {
  id: number;
}
