// src/app/blog/blog-list/blog-list.component.ts
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common'; // Import CommonModule for *ngFor, DatePipe etc.
import { RouterModule } from '@angular/router'; // Import RouterModule for routerLink
import { BlogService } from '../../shared/services/blog.service'; // Adjust path
import { BlogPost } from '../../shared/models/blog-post.model'; // Adjust path

@Component({
  selector: 'app-blog-list',
  standalone: true, // Assuming standalone components based on modern Angular
  imports: [CommonModule, RouterModule], // Add CommonModule and RouterModule
  templateUrl: './blogs.component.html',
  styleUrls: ['./blogs.component.css']
})
export class BlogsComponent implements OnInit {
  allPosts: BlogPost[] = [];
  paginatedPosts: BlogPost[] = [];
  currentPage = 1;
  postsPerPage = 9; // Or your desired number
  totalPages = 1;

  constructor(private blogService: BlogService) { }

  ngOnInit(): void {
    this.blogService.getPosts().subscribe(posts => {
      this.allPosts = posts;
      this.totalPages = Math.ceil(this.allPosts.length / this.postsPerPage);
      this.updatePaginatedPosts();
    });
  }

  updatePaginatedPosts(): void {
    const startIndex = (this.currentPage - 1) * this.postsPerPage;
    const endIndex = startIndex + this.postsPerPage;
    this.paginatedPosts = this.allPosts.slice(startIndex, endIndex);
  }

  goToPage(page: number): void {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
      this.updatePaginatedPosts();
      // Optional: scroll to top
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  nextPage(): void {
    this.goToPage(this.currentPage + 1);
  }

  prevPage(): void {
    this.goToPage(this.currentPage - 1);
  }
}