import { Injectable, Logger } from '@nestjs/common';
import { MonicaClient } from '../monica.client';
import {
  MonicaCreateNotePayload,
  MonicaDeleteNoteResponse,
  MonicaListNotesParams,
  MonicaNote,
  MonicaNoteResponse,
  MonicaNotesListResponse,
  MonicaUpdateNotePayload,
} from './monica-notes.types';

@Injectable()
export class MonicaNotesService {
  private readonly logger = new Logger(MonicaNotesService.name);

  constructor(private readonly monicaClient: MonicaClient) {}

  async listNotes(
    params: MonicaListNotesParams = {},
  ): Promise<MonicaNotesListResponse> {
    const query = this.buildPaginationQuery(params);
    const response = await this.monicaClient.get<MonicaNotesListResponse>(
      '/notes',
      { query },
    );

    if (!response) {
      throw new Error('Monica API returned no content while listing notes.');
    }

    return response;
  }

  async listNotesForContact(
    contactId: number,
    params: MonicaListNotesParams = {},
  ): Promise<MonicaNotesListResponse> {
    const query = this.buildPaginationQuery(params);
    const response = await this.monicaClient.get<MonicaNotesListResponse>(
      `/contacts/${contactId}/notes`,
      { query },
    );

    if (!response) {
      throw new Error(
        `Monica API returned no content while listing notes for contact ${contactId}.`,
      );
    }

    return response;
  }

  async getNote(noteId: number): Promise<MonicaNote> {
    const response = await this.monicaClient.get<MonicaNoteResponse>(
      `/notes/${noteId}`,
    );

    if (!response) {
      throw new Error(`Monica API returned no content for note ${noteId}.`);
    }

    return response.data;
  }

  async createNote(payload: MonicaCreateNotePayload): Promise<MonicaNote> {
    const response = await this.monicaClient.post<
      MonicaNoteResponse,
      MonicaCreateNotePayload
    >('/notes', payload);

    if (!response) {
      throw new Error('Monica API returned no content while creating a note.');
    }

    this.logger.debug(`Created Monica note ${response.data.id}`);
    return response.data;
  }

  async updateNote(
    noteId: number,
    payload: MonicaUpdateNotePayload,
  ): Promise<MonicaNote> {
    const response = await this.monicaClient.put<
      MonicaNoteResponse,
      MonicaUpdateNotePayload
    >(`/notes/${noteId}`, payload);

    if (!response) {
      throw new Error(`Monica API returned no content while updating note ${noteId}.`);
    }

    return response.data;
  }

  async deleteNote(noteId: number): Promise<MonicaDeleteNoteResponse> {
    const response = await this.monicaClient.delete<MonicaDeleteNoteResponse>(
      `/notes/${noteId}`,
    );

    if (!response) {
      throw new Error(`Monica API returned no response while deleting note ${noteId}.`);
    }

    return response;
  }

  private buildPaginationQuery(
    params: MonicaListNotesParams,
  ): Record<string, string | number | boolean | undefined> {
    return {
      limit: params.limit,
      page: params.page,
    };
  }
}
