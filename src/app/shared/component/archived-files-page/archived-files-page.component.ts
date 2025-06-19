// src/app/archived-files-page/archived-files-page.component.ts
import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common'; // Import CommonModule for *ngIf, etc.
import { RouterLink } from '@angular/router'; // For routerLink
import { Subscription } from 'rxjs';

import { AuthService, User } from '../../services/auth.service';
import { FileManagerApiService, TelegramFileMetadata } from '../../services/file-manager-api.service';
import { ByteFormatPipe } from '../../pipes/byte-format.pipe'; // Assuming you have this pipe

@Component({
  selector: 'app-archived-files-page',
  standalone: true,
  imports: [CommonModule, RouterLink, ByteFormatPipe], // Add necessary imports
  templateUrl: './archived-files-page.component.html',
  styleUrls: ['./archived-files-page.component.css', '../user-files-page/user-files-page.component.css'], // Reuse styles
})
export class ArchivedFilesPageComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private apiService = inject(FileManagerApiService);
  private datePipe = inject(DatePipe);
  private cdRef = inject(ChangeDetectorRef);
  private zone = inject(NgZone);

  currentUser: User | null = null;
  username: string = '';
  archivedFiles: TelegramFileMetadata[] = [];
  isLoading: boolean = false;
  error: string | null = null;
  restoringStates: { [accessId: string]: boolean } = {};

  private authSubscription: Subscription | null = null;

  ngOnInit(): void {
    this.authSubscription = this.authService.currentUser$.subscribe(user => {
      this.currentUser = user;
      this.username = this.currentUser?.username || this.currentUser?.email || '';
      if (this.currentUser && this.username) {
        this.loadArchivedFiles();
      } else {
        this.error = "Authentication error. Please log in.";
        this.isLoading = false;
        this.cdRef.detectChanges();
      }
    });
  }

  ngOnDestroy(): void {
    this.authSubscription?.unsubscribe();
  }

  loadArchivedFiles(): void {
    if (!this.username) return;
    this.isLoading = true;
    this.error = null;
    this.cdRef.detectChanges();

    this.apiService.listArchivedFiles(this.username).subscribe({
      next: (files) => this.zone.run(() => {
        this.archivedFiles = files.sort((a, b) => { // Sort by archived_timestamp if available
          const dateA = a['archived_timestamp'] ? new Date(a['archived_timestamp']).getTime() : 0;
          const dateB = b['archived_timestamp'] ? new Date(b['archived_timestamp']).getTime() : 0;
          return dateB - dateA; // Newest archived first
        });
        this.isLoading = false;
        this.cdRef.detectChanges();
      }),
      error: (err) => this.zone.run(() => {
        console.error("ArchivedFilesPage: Error loading archived files:", err);
        this.error = `Failed to load archived files. ${err.message || 'Please try again.'}`;
        if (err.error && err.error.error) this.error += ` Server: ${err.error.error}`;
        this.isLoading = false;
        this.cdRef.detectChanges();
      })
    });
  }

  requestFileRestore(file: TelegramFileMetadata): void {
    if (!file['access_id']) {
      alert("Cannot restore: File information is incomplete.");
      return;
    }
    if (this.restoringStates[file['access_id']]) return; // Already restoring

    this.restoringStates[file['access_id']] = true;
    this.error = null; // Clear previous errors
    this.cdRef.detectChanges();

    this.apiService.restoreFile(file['access_id']).subscribe({
      next: (response) => this.zone.run(() => {
        console.log(`Restore successful for ${file['access_id']}:`, response.message);
        // Remove from current list and reload or filter
        this.archivedFiles = this.archivedFiles.filter(f => f['access_id'] !== file['access_id']);
        delete this.restoringStates[file['access_id']];
        // Optionally, show a success toast/message to the user
        alert(response.message || `File "${this.getDisplayFilename(file)}" restored successfully!`);
        this.cdRef.detectChanges();
      }),
      error: (err) => this.zone.run(() => {
        console.error(`ArchivedFilesPage: Error restoring file ${file['access_id']}:`, err);
        let detail = 'An unexpected error occurred.';
        if (err && err.error && typeof err.error.message === 'string') {
          detail = err.error.message;
        } else if (err && err.error && typeof err.error.error === 'string') {
          detail = err.error.error;
        } else if (err && typeof err.message === 'string') {
          detail = err.message;
        }
        this.error = `Failed to restore "${this.getDisplayFilename(file)}". ${detail}`;
        delete this.restoringStates[file['access_id']];
        this.cdRef.detectChanges();
      })
    });
  }

  // You can reuse getDisplayFilename, getItemSize, getFileIcon from UserFilesPageComponent
  // or create a shared utility service for them. For simplicity here, I'll assume you might copy them
  // or ideally, you'd refactor them into a shared service or base class.

  getDisplayFilename(file: TelegramFileMetadata): string {
    // For batches, the batch_display_name is the priority.
    if (file['is_batch']) {
      return file['batch_display_name'] || 'Unnamed Batch';
    }

    // For single files, the name is likely inside the files_in_batch array.
    if (file['files_in_batch'] && file['files_in_batch'].length > 0 && file['files_in_batch'][0].original_filename) {
      return file['files_in_batch'][0].original_filename;
    }

    // Fallback for older data structures or edge cases.
    return file['original_filename'] || file['name'] || file['sent_filename'] || 'Unnamed File';
  }

  getItemSize(file: TelegramFileMetadata): number {
    if (file['is_batch']) {
      return file['total_original_size'] ?? 0;
    }
    return file['original_size'] ?? file['size'] ?? 0;
  }

  // Re-use or adapt from user-files-page.component.ts
  getFileIcon(file: TelegramFileMetadata): string {
    // For multi-file batches, always show a folder/archive icon.
    if (file['is_batch'] && file['files_in_batch'] && file['files_in_batch'].length > 1) {
      return 'fas fa-folder-open text-warning';
    }

    // For single files OR batches-of-one, find the single filename to determine the icon.
    let filenameForIcon: string | undefined;
    if (file['files_in_batch'] && file['files_in_batch'].length > 0) {
      filenameForIcon = file['files_in_batch'][0].original_filename;
    }

    // Fallback to top-level names if files_in_batch is missing for some reason.
    if (!filenameForIcon) {
      filenameForIcon = file['original_filename'] || file['name'] || file['sent_filename'];
    }

    // If still no name, return the question mark icon.
    if (!filenameForIcon) {
      return 'fas fa-question-circle text-muted';
    }

    const extension = filenameForIcon.split('.').pop()?.toLowerCase();
    if (!extension) return 'fas fa-file text-muted';

    switch (extension) {
      case 'pdf': return 'fas fa-file-pdf text-danger';
      case 'doc': case 'docx': return 'fas fa-file-word text-primary';
      case 'xls': case 'xlsx': return 'fas fa-file-excel text-success';
      case 'zip': case 'rar': return 'fas fa-file-archive text-secondary';
      case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': return 'fas fa-file-image text-purple';
      case 'mp3': case 'wav': case 'ogg': return 'fas fa-file-audio text-orange';
      case 'mp4': case 'mov': case 'avi': return 'fas fa-file-video text-info';
      default: return 'fas fa-file text-muted';
    }
  }

  formatArchivedDate(timestamp: string | Date | undefined): string {
    if (!timestamp) return 'N/A';
    try {
      return this.datePipe.transform(timestamp, 'yyyy-MM-dd HH:mm') || 'Invalid Date';
    } catch (e) {
      return 'Invalid Date';
    }
  }

  // Optional: Add a method to navigate back if needed, though routerLink is often enough
  goBackToFiles(): void {
    // this.router.navigate(['/my-files']); // Assuming '/my-files' is the route for UserFilesPageComponent
  }
}