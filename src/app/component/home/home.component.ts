// frontend/src/app/features/home/home.component.ts

import {
  Component,
  inject,
  ViewChild,
  ElementRef,
  OnInit,
  OnDestroy,
  NgZone,
  ChangeDetectorRef,
  HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  Observable,
  Subscription,
  catchError,
  firstValueFrom,
  throwError,
  EMPTY
} from 'rxjs';
import { AuthService, User } from '../../shared/services/auth.service';
import {
  FileManagerApiService,
  FinalizeBatchResponse
} from '../../shared/services/file-manager-api.service';
import { SelectedItem } from '../transfer-panel/transfer-panel.component';
import { FaqAccordionComponent } from '../faq-accordion/faq-accordion.component';
import { UploadEventService } from '../../shared/services/upload-event.service';
import { OrbitalDisplayComponent } from '@app/shared/component/orbital-display/orbital-display.component';
import { ScrollAnimationDirective } from '@app/shared/directives/scroll-animation.directive';
import { GamesComponent } from '@app/shared/component/games/games.component';

interface UploadProgressDetails {
  percentage: number;
  bytesSent: number;
  totalBytes: number;
  speedMBps: number;
  etaFormatted: string;
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    FaqAccordionComponent,
    OrbitalDisplayComponent,
    ScrollAnimationDirective,
    GamesComponent
  ],
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css'],
  providers: []
})
export class HomeComponent implements OnInit, OnDestroy {
  // ───────────────── Injections ───────────────────
  private authService = inject(AuthService);
  private apiService = inject(FileManagerApiService);
  private zone = inject(NgZone);
  private cdRef = inject(ChangeDetectorRef);
  private uploadEventService = inject(UploadEventService);

  // ───────────────── Public UI state ──────────────
  completedBatchAccessId: string | null = null;
  shareableLinkForPanel: string | null = null;
  showPlayGamesButton = false;
  isGamePanelVisible = false;
  anonymousUploadLimitMessage: string | null = null;

  // ───────────────── Private constants ────────────
  private readonly ONE_GB = 1 * 1024 * 1024 * 1024;
  private readonly FIVE_GB = 5 * 1024 * 1024 * 1024;
  private readonly MAX_ANON_FOLDERS = 5;

  // ───────────────── Element refs ─────────────────
  @ViewChild('fileInputForStart') fileInputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('folderInputForStart') folderInputRef!: ElementRef<HTMLInputElement>;

  // ───────────────── User / upload state ──────────
  currentUser: User | null = null;
  username = '';
  isUploading = false;
  uploadError: string | null = null;
  uploadSuccessMessage: string | null = null;
  selectedItems: SelectedItem[] = [];
  currentItemBeingUploaded: SelectedItem | null = null;
  userFileCount = 0;
  isLoadingUserFileCount = false;
  uploadStatusMessage = '';
  uploadProgressDetails: UploadProgressDetails = {
    percentage: 0,
    bytesSent: 0,
    totalBytes: 0,
    speedMBps: 0,
    etaFormatted: '--:--'
  };
  uploadProgress = 0;

  // ───────────────── Internals ─────────────────────
  private nextItemId = 0;
  private authSubscription: Subscription | null = null;
  private progressSubscription: Subscription | null = null;
  private uploadStartTime = 0;
  private previousShowPlayGamesButtonState = false;
  private anonymousFolderUploadsCount = 0;
  private dragEnterCounter = 0;

  // ───────────────── Host listeners ────────────────
  @HostListener('window:beforeunload', ['$event'])
  handleBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.isUploading) {
      event.preventDefault();
      event.returnValue = 'Leaving will cancel your current upload. Proceed?';
    }
  }

  // ───────────────── Lifecycle ─────────────────────
  ngOnInit(): void {
    this.authSubscription = this.authService.currentUser$.subscribe(user => {
      this.zone.run(() => {
        const wasLogged = !!this.currentUser;
        this.currentUser = user;
        this.username = user?.username || user?.email || '';

        if (!user && wasLogged) {
          this.resetUploadState();
        }

        if (this.currentUser && this.username) {
          this.loadUserFileCount();
        } else {
          this.userFileCount = 0;
          this.isLoadingUserFileCount = false;
        }
        this.cdRef.detectChanges();
      });
    });

    // initial load
    this.currentUser = this.authService.currentUserValue;
    this.username = this.currentUser?.username || this.currentUser?.email || '';
    if (this.currentUser && this.username) this.loadUserFileCount();
  }

  ngOnDestroy(): void {
    this.authSubscription?.unsubscribe();
    this.progressSubscription?.unsubscribe();
  }

  // ───────────────── Helpers ───────────────────────
  private formatEta(totalSeconds: number): string {
    if (!isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return h > 0
      ? `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s
          .toString()
          .padStart(2, '0')}`
      : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  private updatePlayGamesButtonVisibility(): void {
    const totalSelectedSize = this.selectedItems.reduce((sum, i) => sum + i.size, 0);
    const newState = totalSelectedSize >= this.ONE_GB;
    if (newState && !this.previousShowPlayGamesButtonState) this.playNotificationSound();
    this.showPlayGamesButton = newState;
    this.previousShowPlayGamesButtonState = newState;
    if (!newState) this.isGamePanelVisible = false;
    this.cdRef.detectChanges();
  }

  private playNotificationSound(): void {
    const audio = new Audio('assets/audio/new-notification-3-323602.mp3');
    audio.play().catch(() => {});
  }

  private resetUploadState(): void {
    this.isUploading = false;
    this.uploadError = null;
    this.uploadSuccessMessage = null;
    this.selectedItems = [];
    this.shareableLinkForPanel = null;
    this.completedBatchAccessId = null;
    this.currentItemBeingUploaded = null;
    this.uploadStatusMessage = '';
    this.uploadProgressDetails = { percentage: 0, bytesSent: 0, totalBytes: 0, speedMBps: 0, etaFormatted: '--:--' };
    this.uploadProgress = 0;
    this.nextItemId = 0;
    this.anonymousUploadLimitMessage = null;
    this.anonymousFolderUploadsCount = 0;
    this.dragEnterCounter = 0;
    this.uploadStartTime = 0;
    this.fileInputRef?.nativeElement && (this.fileInputRef.nativeElement.value = '');
    this.folderInputRef?.nativeElement && (this.folderInputRef.nativeElement.value = '');
    this.progressSubscription?.unsubscribe();
    this.progressSubscription = null;
    this.updatePlayGamesButtonVisibility();
  }

  // ───────────────── User‑file count ───────────────
  loadUserFileCount(): void {
    if (!this.currentUser || !this.username) return;
    this.isLoadingUserFileCount = true;
    this.apiService.listFiles(this.username).subscribe({
      next: files => {
        this.zone.run(() => {
          this.userFileCount = files.length;
          this.isLoadingUserFileCount = false;
          this.cdRef.detectChanges();
        });
      },
      error: err => {
        this.zone.run(() => {
          console.error('Error loading file count:', err);
          this.userFileCount = 0;
          this.isLoadingUserFileCount = false;
          this.cdRef.detectChanges();
        });
      }
    });
  }

  // ───────────────── Drag‑n‑drop stubs (unchanged) ─
  @HostListener('window:dragenter', ['$event']) onWindowDragEnter(_: DragEvent): void {}
  @HostListener('window:dragover', ['$event']) onWindowDragOver(_: DragEvent): void {}
  @HostListener('window:dragleave', ['$event']) onWindowDragLeave(_: DragEvent): void {}
  @HostListener('window:drop', ['$event']) onWindowDrop(_: DragEvent): void {}

  // ───────────────── File‑selection helpers (handleFiles simplified) ─
  handleFiles(fileList: FileList, isFolderSelection = false): void {
    if (this.isUploading) {
      alert('Wait for the current upload to finish.');
      return;
    }
    // Minimal: just add to selectedItems with basic checks
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (file.size === 0 && !isFolderSelection) continue;
      const itemName = file.webkitRelativePath || file.name;
      this.selectedItems.push({
        id: this.nextItemId++,
        file,
        name: itemName,
        size: file.size,
        icon: 'fas fa-file'
      });
    }
    this.updatePlayGamesButtonVisibility();
  }

  // ───────────────── Main upload flow ──────────────
  async initiateTransferFromPanel(): Promise<void> {
    if (this.isUploading || this.selectedItems.length === 0) return;
    this.isUploading = true;
    this.uploadError = null;
    this.uploadProgressDetails.totalBytes = this.selectedItems.reduce((s, i) => s + (i.file?.size ?? 0), 0);
    this.uploadProgressDetails.speedMBps = 0;
    this.uploadProgressDetails.etaFormatted = '--:--';
    this.updateOverallProgress(0);
    this.uploadStartTime = Date.now();

    const batchName = this.selectedItems.length === 1 ? this.selectedItems[0].name : `Batch of ${this.selectedItems.length} files`;

    const initRes = await firstValueFrom(
      this.apiService.initiateBatch(batchName, this.uploadProgressDetails.totalBytes, this.selectedItems.length > 1)
    );
    const batchId = initRes.batch_id;
    let bytesUploadedSoFar = 0;

    this.progressSubscription = this.apiService.getUploadProgressStream(batchId).subscribe({
      next: ev => this.zone.run(() => this.handleProgressEvent(ev, bytesUploadedSoFar)),
      error: er => this.zone.run(() => this.handleBatchUploadError('Progress stream failed.', er))
    });

    try {
      for (const item of this.selectedItems) {
        if (!item.file) continue;
        await this.streamFileWithFetch(item, batchId);
        bytesUploadedSoFar += item.file.size;
      }
      const finalRes = await firstValueFrom(this.apiService.finalizeBatch(batchId));
      this.onAllUploadsComplete(finalRes);
    } catch (err: any) {
      this.handleBatchUploadError(err.message || 'Unknown upload error');
    } finally {
      this.progressSubscription?.unsubscribe();
      this.progressSubscription = null;
    }
  }

  private async streamFileWithFetch(item: SelectedItem, batchId: string): Promise<void> {
    if (!item.file) return;
    const apiUrl = this.apiService.getApiBaseUrl();
    const authToken = this.authService.getToken();
    const url = `${apiUrl}/upload/stream?batch_id=${batchId}&filename=${encodeURIComponent(item.name)}`;

    const headers: Record<string, string> = {
      'X-Filesize': item.file.size.toString(),
      'Authorization': `Bearer ${authToken}`
    };

    const res = await fetch(url, { method: 'POST', headers, body: item.file });
    if (!res.ok) {
      const txt = await res.text();
      try {
        const j = JSON.parse(txt);
        throw new Error(j.error || j.message || `Status ${res.status}`);
      } catch {
        throw new Error(txt || `Status ${res.status}`);
      }
    }
  }

  // ───────────────── SSE progress handler ──────────
  private handleProgressEvent(event: any, previouslySent: number): void {
    // minimal: just update percentage if provided
    if (event.type === 'progress' && typeof event.percentage === 'number') {
      this.uploadProgressDetails.percentage = event.percentage;
      this.uploadProgress = event.percentage;
      this.cdRef.detectChanges();
    }
  }

  private updateOverallProgress(bytesSent: number): void {
    const totalBytes = this.uploadProgressDetails.totalBytes || 1;
    this.uploadProgressDetails.percentage = (bytesSent / totalBytes) * 100;
    this.uploadProgressDetails.bytesSent = bytesSent;
    this.uploadProgress = this.uploadProgressDetails.percentage;
    this.cdRef.detectChanges();
  }

  private handleBatchUploadError(message: string, err?: any): void {
    console.error('Upload error:', message, err);
    this.uploadError = message;
    this.isUploading = false;
    this.uploadStatusMessage = 'Upload Failed';
    this.cdRef.detectChanges();
  }

  private onAllUploadsComplete(finalData: FinalizeBatchResponse): void {
    this.isUploading = false;
    this.uploadStatusMessage = 'Transfer complete!';
    this.shareableLinkForPanel = finalData.download_url;
    this.completedBatchAccessId = finalData.access_id;
    this.updateOverallProgress(this.uploadProgressDetails.totalBytes);
    this.cdRef.detectChanges();
  }

  // ───────────────── Misc stubs (left unchanged) ───
  handleCancelUpload(): void {}
  handleDownloadRequest(_: SelectedItem): void {}
  handleDataTransferItemsDropped(_: DataTransferItemList | null): void {}
  toggleGamePanel(): void { this.isGamePanelVisible = !this.isGamePanelVisible; }
  closeGamePanel(): void { this.isGamePanelVisible = false; }

  private handleError(error: any): Observable<never> {
    return throwError(() => error);
  }

  // Utility to generate icons – simplified
  getFileIcon(_: string | undefined): string {
    return 'fas fa-file';
  }
}
