import { Injectable, Logger } from '@nestjs/common';
import { MonicaClient } from '../monica.client';
import {
  parseMonicaContactResponse,
  parseMonicaContactsListResponse,
  parseMonicaDeleteContactResponse,
} from '../monica.guards';
import {
  MonicaContact,
  MonicaContactResponse,
  MonicaContactsListResponse,
  MonicaDeleteContactResponse,
  MonicaGetContactOptions,
  MonicaListContactsParams,
  MonicaSearchContactsParams,
  MonicaUpdateContactCareerPayload,
  MonicaUpdateContactPayload,
} from './monica-contacts.types';

@Injectable()
export class MonicaContactsService {
  private readonly logger = new Logger(MonicaContactsService.name);

  constructor(private readonly monicaClient: MonicaClient) {}

  async listContacts(
    params: MonicaListContactsParams = {},
  ): Promise<MonicaContactsListResponse> {
    const query = this.buildListQuery(params);
    const response = await this.monicaClient.get<MonicaContactsListResponse>(
      '/contacts',
      { query, parseResponse: parseMonicaContactsListResponse },
    );

    if (!response) {
      throw new Error('Monica API returned no content while listing contacts.');
    }

    return response;
  }

  async searchContacts(
    params: MonicaSearchContactsParams,
  ): Promise<MonicaContactsListResponse> {
    const response = await this.listContacts({
      ...params,
      query: params.query,
    });

    this.logger.debug(
      `Search for "${params.query}" returned ${response.data.length} contacts`,
    );

    return response;
  }

  async getContact(
    contactId: number,
    options: MonicaGetContactOptions = {},
  ): Promise<MonicaContact> {
    const query = this.buildGetContactQuery(options);
    const response = await this.monicaClient.get<MonicaContactResponse>(
      `/contacts/${contactId}`,
      { query, parseResponse: parseMonicaContactResponse },
    );

    if (!response) {
      throw new Error(
        `Monica API returned no content for contact ${contactId}.`,
      );
    }

    return response.data;
  }

  async updateContact(
    contactId: number,
    payload: MonicaUpdateContactPayload,
  ): Promise<MonicaContact> {
    const response = await this.monicaClient.put<
      MonicaContactResponse,
      MonicaUpdateContactPayload
    >(`/contacts/${contactId}`, payload, {
      parseResponse: parseMonicaContactResponse,
    });

    if (!response) {
      throw new Error(
        `Monica API returned no content while updating contact ${contactId}.`,
      );
    }

    return response.data;
  }

  async updateContactCareer(
    contactId: number,
    payload: MonicaUpdateContactCareerPayload,
  ): Promise<MonicaContact> {
    const response = await this.monicaClient.put<
      MonicaContactResponse,
      MonicaUpdateContactCareerPayload
    >(`/contacts/${contactId}/work`, payload, {
      parseResponse: parseMonicaContactResponse,
    });

    if (!response) {
      throw new Error(
        `Monica API returned no content while updating contact ${contactId} career info.`,
      );
    }

    return response.data;
  }

  async removeContact(contactId: number): Promise<MonicaDeleteContactResponse> {
    const response =
      await this.monicaClient.delete<MonicaDeleteContactResponse>(
        `/contacts/${contactId}`,
        { parseResponse: parseMonicaDeleteContactResponse },
      );

    if (!response) {
      throw new Error(
        `Monica API returned no response while deleting contact ${contactId}.`,
      );
    }

    return response;
  }

  private buildListQuery(
    params: MonicaListContactsParams,
  ): Record<string, string | number | boolean | undefined> {
    return {
      limit: params.limit,
      page: params.page,
      sort: params.sort,
      query: params.query,
    };
  }

  private buildGetContactQuery(
    options: MonicaGetContactOptions,
  ): Record<string, string | number | boolean | undefined> {
    return {
      with: options.includeContactFields ? 'contactfields' : undefined,
    };
  }
}
