import { Injectable, inject } from '@angular/core';
import {
  HttpClient,
  HttpErrorResponse,
  HttpParams,
  HttpHeaders,
  HttpEvent
} from '@angular/common/http';
import { Observable, throwError, EMPTY } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';
import { PreviewDetails } from '../../interfaces/batch.interfaces';

// ---------------------------------------------------------------------------
//  Interfaces (unchanged – trimmed here for brevity)
// ---------------------------------------------------------------------------
export interface StreamUploadResponse {
  message: string;
  access_id: string;
  download_url: string;
  gdrive_file_id: string;
}
export interface FileInBatch {
  original_filename: string;
  original_size?: number;
  failed?: boolean;
  reason?: string | null;
  skipped?: boolean;
  send_locations?: any[];
}
export interface TelegramFileMetadata {
  // ... all existing fields ...
  [key: string]: any;
}
export interface InitiateUploadResponse {
  upload_id: string;
  filename: string;
  sse_gdrive_upload_url?: string;
  shareable_link?: string;
  message?: string;
  access_id?: string;
}
export interface ApiResponse {
  success?: boolean;
  message?: string;
  error?: string;
}
export interface BasicApiResponse {
  success?: boolean;
  message?: string;
  error?: string;
}
export interface SelectedItem {
  id: number;
  file: File;
  name: string;
  size: number;
  isFolder?: boolean;
  icon: string;
}
export interface DownloadAllInitiationResponse {
  message?: string;
  prep_id_for_zip?: string;
  sse_stream_url?: string;
  error?: string;
}
export interface SseReadyPayload {
  temp_file_id: string;
  final_filename: string;
}
export interface InitiateStreamResponse {
  message: string;
  operation_id: string;
}
export interface InitiateBatchResponse {
  message: string;
  batch_id: string;
}
export interface FinalizeBatchResponse {
  message: string;
  access_id: string;
  download_url: string;
}

@Injectable({ providedIn: 'root' })
export class FileManagerApiService {
  private apiUrl = environment.apiUrl;
  private http = inject(HttpClient);
  private authService = inject(AuthService);

  /** Expose the raw API base (useful for constructing absolute URLs). */
  public getApiBaseUrl(): string {
    return this.apiUrl;
  }

  // ==========================================================================
  // === 1. PROGRESS SSE STREAM  (unchanged) ===================================
  // ==========================================================================
  getUploadProgressStream(batchId: string): Observable<any> {
    const url = `${this.apiUrl}/upload/progress-stream/${batchId}`;
    console.log(`[ApiService] Opening progress SSE stream at: ${url}`);

    return new Observable(observer => {
      const eventSource = new EventSource(url, { withCredentials: true });

      ['progress', 'status', 'error', 'finalized'].forEach(type => {
        eventSource.addEventListener(type, (event: MessageEvent) => {
          try {
            observer.next(JSON.parse(event.data));
          } catch {
            observer.error(new Error(`Failed to parse ${type} event.`));
          }
        });
      });

      eventSource.onerror = ev => {
        console.error(`[ApiService] SSE error for batch ${batchId}:`, ev);
        observer.error(new Error('Connection to progress stream failed.'));
        eventSource.close();
      };

      return () => {
        if (eventSource && eventSource.readyState !== eventSource.CLOSED) {
          console.log(`[ApiService] Closing progress SSE stream for batch ${batchId}.`);
          eventSource.close();
        }
      };
    });
  }

  // ==========================================================================
  // === 2. NEW BACKEND ENDPOINTS  ============================================
  // ==========================================================================

  /**
   * Step 1 (new flow) – ask the backend to start a Google-Drive
   * resumable-upload session and return the session URI.
   */
  initiateGdriveSession(
    filename: string,
    filesize: number,
    mimetype: string
  ): Observable<{ session_uri: string }> {
    const url = `${this.apiUrl}/upload/initiate-gdrive-session`;
    const body = { filename, filesize, mimetype };
    return this.http.post<{ session_uri: string }>(url, body)
      .pipe(catchError(this.handleError));
  }

  /**
   * Step 2 (new flow) – once the front-end has PUT the bytes to Drive using
   * the session URI, register the finished file so our backend knows it
   * belongs to the batch.
   */
  registerGdriveUpload(
    batchId: string,
    gdriveFileId: string,
    originalFilename: string,
    originalSize: number
  ): Observable<{ message: string }> {
    const url = `${this.apiUrl}/upload/register-gdrive-upload`;
    const body = {
      batch_id: batchId,
      gdrive_file_id: gdriveFileId,
      original_filename: originalFilename,
      original_size: originalSize
    };
    return this.http.post<{ message: string }>(url, body)
      .pipe(catchError(this.handleError));
  }

  // ==========================================================================
  // === 3. LEGACY UPLOAD HELPERS  (still used by drop-zone component) ========
  // ==========================================================================
  initiateBatch(batchName: string, totalSize: number, isBatch: boolean): Observable<InitiateBatchResponse> {
    const url = `${this.apiUrl}/upload/initiate-batch`;
    return this.http.post<InitiateBatchResponse>(url, {
      batch_display_name: batchName,
      total_original_size: totalSize,
      is_batch: isBatch
    }).pipe(catchError(this.handleError));
  }

  /** Deprecated by fetch-stream in component, kept for possible reuse. */
  streamFileToBatch(file: File, batchId: string): Observable<HttpEvent<any>> {
    const url = `${this.apiUrl}/upload/stream`;
    const headers = new HttpHeaders({
      'X-Filename': file.name,
      'X-Filesize': file.size.toString(),
      'X-Batch-Id': batchId
    });
    return this.http.post(url, file, { headers, reportProgress: true, observe: 'events' });
  }

  finalizeBatch(batchId: string): Observable<FinalizeBatchResponse> {
    const url = `${this.apiUrl}/upload/finalize-batch/${batchId}`;
    return this.http.post<FinalizeBatchResponse>(url, {})
      .pipe(catchError(this.handleError));
  }

  // ==========================================================================
  // === 4. FILE LIST / DELETE / PREVIEW / DOWNLOAD  (unchanged) ==============
  // ==========================================================================
  listFiles(username: string): Observable<TelegramFileMetadata[]> {
    return this.http.get<TelegramFileMetadata[]>(`${this.apiUrl}/api/files/${encodeURIComponent(username)}`)
      .pipe(catchError(this.handleError));
  }

  deleteFileRecord(username: string, identifier: string): Observable<BasicApiResponse> {
    return this.http.delete<BasicApiResponse>(
      `${this.apiUrl}/api/delete-file/${encodeURIComponent(username)}/${encodeURIComponent(identifier)}`
    ).pipe(catchError(this.handleError));
  }

  listArchivedFiles(username: string): Observable<TelegramFileMetadata[]> {
    return this.http.get<TelegramFileMetadata[]>(
      `${this.apiUrl}/api/archive/list-files/${encodeURIComponent(username)}`
    ).pipe(catchError(this.handleError));
  }

  restoreFile(accessId: string): Observable<ApiResponse> {
    return this.http.post<ApiResponse>(
      `${this.apiUrl}/api/archive/restore-file/${encodeURIComponent(accessId)}`, {}
    ).pipe(catchError(this.handleError));
  }

  getPreviewDetails(accessId: string, filename?: string | null): Observable<PreviewDetails> {
    let params = new HttpParams();
    if (filename) params = params.set('filename', filename);
    return this.http.get<PreviewDetails>(`${this.apiUrl}/api/preview-details/${accessId}`, { params })
      .pipe(catchError(this.handleError));
  }

  getRawTextContent(contentUrl: string): Observable<string> {
    const fullUrl = contentUrl.startsWith('http') ? contentUrl : `${this.apiUrl}${contentUrl}`;
    const token = this.authService.getToken();
    const headers = token ? new HttpHeaders().set('Authorization', `Bearer ${token}`) : new HttpHeaders();
    return this.http.get(fullUrl, { headers, responseType: 'text' })
      .pipe(catchError(this.handleError));
  }

  public downloadFileBlob(accessId: string, isBatch: boolean): Observable<Blob> {
    if (!accessId) {
      return throwError(() => new Error('Access ID required for download.'));
    }

    return new Observable(observer => {
      let initialApiUrl: string;
      let isTwoStepSse = false;

      if (isBatch) {
        initialApiUrl = `${this.apiUrl}/download/initiate-download-all/${accessId}`;
        isTwoStepSse = true;
      } else {
        initialApiUrl = `${this.apiUrl}/download/stream-download/${accessId}`;
      }
      console.log(`[ApiService.downloadFileBlob] Initial API/SSE URL for ${accessId} (isBatch: ${isBatch}): ${initialApiUrl}`);

      let eventSource: EventSource | null = null;

      const setupPrimarySseConnection = (primarySseUrl: string) => {
        if (eventSource) {
          console.warn('[ApiService.downloadFileBlob] Closing existing EventSource before creating new one.');
          eventSource.close();
        }
        console.log(`[ApiService.downloadFileBlob] Connecting to primary SSE: ${primarySseUrl}`);
        eventSource = new EventSource(primarySseUrl, { withCredentials: true });

        eventSource.onopen = () => {
          console.log(`[ApiService.downloadFileBlob] SSE connection opened to: ${primarySseUrl}`);
        };

        eventSource.addEventListener('status', (event: MessageEvent) => {
          console.debug('[ApiService.downloadFileBlob] SSE status:', event.data);
        });

        eventSource.addEventListener('progress', (event: MessageEvent) => {
          console.debug('[ApiService.downloadFileBlob] SSE progress:', event.data);
        });

        eventSource.addEventListener('ready', (event: MessageEvent) => {
          console.log('[ApiService.downloadFileBlob] SSE "ready" event received:', event.data);
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }

          try {
            const data: SseReadyPayload = JSON.parse(event.data);
            if (!data.temp_file_id || !data.final_filename) {
              console.error('[ApiService.downloadFileBlob] "ready" event missing temp_file_id or final_filename.');
              observer.error(new Error('Download preparation failed: Incomplete server response from "ready" event.'));
              return;
            }
            const token = this.authService.getToken();
            const headers = token ? new HttpHeaders().set('Authorization', `Bearer ${token}`) : new HttpHeaders();
            const finalDownloadUrl = `${this.apiUrl}/download/serve-temp-file/${data.temp_file_id}/${encodeURIComponent(data.final_filename)}`;
            console.log(`[ApiService.downloadFileBlob] Triggering final blob download from: ${finalDownloadUrl}`);

            this.http.get(finalDownloadUrl, { responseType: 'blob', headers: headers })
              .pipe(catchError(blobFetchError => {
                console.error('[ApiService.downloadFileBlob] Error fetching blob:', blobFetchError);
                this.handleError(blobFetchError as HttpErrorResponse).subscribe({
                  error: (processedError: Error) => observer.error(processedError)
                });
                return EMPTY;
              }))
              .subscribe(blob => {
                observer.next(blob);
                observer.complete();
              });
          } catch (e: any) {
            console.error('[ApiService.downloadFileBlob] Error processing "ready" event:', e);
            observer.error(new Error(e.message || 'Error processing download readiness.'));
          }
        });

        eventSource.addEventListener('error', (event: MessageEvent) => {
          console.error('[ApiService.downloadFileBlob] SSE "error" event from backend:', event.data);
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          let msg = 'File preparation error reported by server.';
          try {
            if (event.data) {
              const parsedError = JSON.parse(event.data);
              msg = parsedError.message || parsedError.error || msg;
            }
          } catch (e) {
            console.warn('[ApiService.downloadFileBlob] Could not parse SSE error event data:', event.data);
          }
          observer.error(new Error(msg));
        });

        eventSource.onerror = (err: Event) => {
          console.error('[ApiService.downloadFileBlob] EventSource general connection error:', err, 'URL:', primarySseUrl);
          if (eventSource) {
            eventSource.close();
            eventSource = null;
            observer.error(new Error('Connection error during file preparation. Check network or server status.'));
          }
        };
      };

      if (isTwoStepSse) {
        const token = this.authService.getToken();
        const headers = token ? new HttpHeaders().set('Authorization', `Bearer ${token}`) : new HttpHeaders();
        this.http.get<DownloadAllInitiationResponse>(initialApiUrl, { headers: headers })
          .pipe(catchError(initError => {
            console.error('[ApiService.downloadFileBlob] Error initiating batch download all:', initError);
            this.handleError(initError as HttpErrorResponse).subscribe({
              error: (processedError: Error) => observer.error(processedError)
            });
            return EMPTY;
          }))
          .subscribe(response => {
            if (response && response.sse_stream_url) {
              const sseStreamUrl = response.sse_stream_url.startsWith('http') ? response.sse_stream_url : `${this.apiUrl}${response.sse_stream_url}`;
              setupPrimarySseConnection(sseStreamUrl);
            } else {
              const errMsg = response?.error || 'Failed to get download stream URL for batch operation.';
              console.error(`[ApiService.downloadFileBlob] Invalid initiation response for batch: ${errMsg}`);
              observer.error(new Error(errMsg));
            }
          });
      } else {
        setupPrimarySseConnection(initialApiUrl);
      }

      return () => {
        if (eventSource) {
          console.log('[ApiService.downloadFileBlob] Cleaning up EventSource on unsubscribe.');
          eventSource.close();
          eventSource = null;
        }
      };
    });
  }
  private handleError(error: HttpErrorResponse): Observable<never> {
    let userMessage = 'An unexpected error occurred. Check backend connection/logs.';
    console.error(`API Error: Status ${error.status}, Body: `, error.error, `URL: ${error.url}`);

    if (error.error instanceof Blob && error.error.type && error.error.type.toLowerCase().includes('json')) {
      return new Observable(observer => {
        const reader = new FileReader();
        reader.onload = (e: any) => {
          try {
            const err = JSON.parse(e.target.result);
            userMessage = err.message || err.error || `Server error (${error.status}).`;
            if (err.status === 410 && err.preview_type === 'expired') {
              observer.error({ ...err, status: err.status, message: userMessage });
              return;
            }
            console.error(`Parsed Blob Error: ${userMessage}`);
          } catch (parseError) {
            userMessage = `Failed to parse error response from server (${error.status}).`;
            console.error(`Error parsing blob error: ${parseError}`);
          }
          observer.error(new Error(userMessage));
        };
        reader.onerror = () => {
          console.error('FileReader failed to read error blob.');
          observer.error(new Error(`Failed to read error response from server (${error.status}).`));
        };
        reader.readAsText(error.error);
      });
    } else if (error.status === 410 && error.error.preview_type === 'expired') {
      userMessage = error.error.error || error.error.message || 'File link has expired.';
      return throwError(() => ({ ...error.error, status: error.status, message: userMessage }));
    } else if (error.error && typeof error.error.error === 'string') {
      userMessage = error.error.error;
    } else if (error.error && typeof error.error.message === 'string') {
      userMessage = error.error.message;
    } else if (typeof error.error === 'string') {
      userMessage = error.error;
    } else if (error.status === 0) {
      userMessage = 'Cannot connect to the backend server. Please check your network connection and ensure the server is running.';
    } else if (error.status === 400) {
      userMessage = `Bad request (${error.status}). ${error.error?.error || 'Please check your input.'}`;
    } else if (error.status === 401) {
      userMessage = `Unauthorized (${error.status}). Please log in or check your permissions.`;
    } else if (error.status === 403) {
      userMessage = `Forbidden (${error.status}). You do not have permission to access this resource.`;
    } else if (error.status === 404) {
      userMessage = `Requested resource not found on the server (${error.status}).`;
    } else if (error.status === 410) {
      userMessage = 'The requested resource is no longer available (Expired or Removed).';
    } else if (error.status === 500) {
      userMessage = `Internal server error (${error.status}). Please try again later or contact support.`;
    } else if (error.message) {
      userMessage = `Error (${error.status}): ${error.message}`;
    }

    console.error(`Final user message for error: ${userMessage}`);
    return throwError(() => new Error(userMessage));
  }
}