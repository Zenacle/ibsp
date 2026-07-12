// ===== SCROLL PROGRESS BAR =====
const progressBar = document.getElementById('scrollProgress');
window.addEventListener('scroll', () => {
  const scrollTop = window.scrollY;
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  const progress = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
  if (progressBar) progressBar.style.width = progress + '%';
});

// ===== NAVBAR SCROLL =====
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  if (window.scrollY > 60) {
    navbar.classList.add('scrolled');
  } else {
    navbar.classList.remove('scrolled');
  }
});

// ===== MOBILE NAV =====
const hamburger = document.getElementById('navHamburger');
const navLinks = document.getElementById('navLinks');

hamburger.addEventListener('click', () => {
  navLinks.classList.toggle('open');
  hamburger.classList.toggle('active');
});

// Close mobile nav on link click
navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
    hamburger.classList.remove('active');
  });
});

// ===== CURRICULUM ACCORDION =====
document.querySelectorAll('.module-header').forEach(header => {
  header.addEventListener('click', () => {
    const item = header.parentElement;
    const content = item.querySelector('.module-content');
    const isOpen = item.classList.contains('open');

    // Close all modules
    document.querySelectorAll('.module-item').forEach(m => {
      m.classList.remove('open');
      m.querySelector('.module-content').style.maxHeight = null;
    });

    // Open clicked (if it wasn't already open)
    if (!isOpen) {
      item.classList.add('open');
      content.style.maxHeight = content.scrollHeight + 'px';
    }
  });
});

// ===== FAQ ACCORDION =====
document.querySelectorAll('.faq-question').forEach(question => {
  question.addEventListener('click', () => {
    const item = question.parentElement;
    const answer = item.querySelector('.faq-answer');
    const isOpen = item.classList.contains('open');

    // Close all FAQs
    document.querySelectorAll('.faq-item').forEach(f => {
      f.classList.remove('open');
      f.querySelector('.faq-answer').style.maxHeight = null;
    });

    // Open clicked (if it wasn't already open)
    if (!isOpen) {
      item.classList.add('open');
      answer.style.maxHeight = answer.scrollHeight + 'px';
    }
  });
});

// ===== SCROLL REVEAL ANIMATION =====
const revealElements = document.querySelectorAll('.reveal');

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('active');
    }
  });
}, {
  threshold: 0.1,
  rootMargin: '0px 0px -50px 0px'
});

revealElements.forEach(el => revealObserver.observe(el));

// ===== SMOOTH SCROLL FOR ANCHOR LINKS =====
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    const href = this.getAttribute('href');
    if (href === '#') return;
    e.preventDefault();
    const target = document.querySelector(href);
    if (target) {
      const offsetTop = target.offsetTop - 80;
      window.scrollTo({
        top: offsetTop,
        behavior: 'smooth'
      });
    }
  });
});

// ===== OPEN FIRST MODULE BY DEFAULT =====
window.addEventListener('DOMContentLoaded', () => {
  const firstModule = document.querySelector('.module-item');
  if (firstModule) {
    firstModule.classList.add('open');
    const content = firstModule.querySelector('.module-content');
    content.style.maxHeight = content.scrollHeight + 'px';
  }
});

// ===== DIRECT ENROLLMENT FORM SUBMISSION =====
const enrollmentForm = document.getElementById('enrollmentForm');
const formSuccess = document.getElementById('formSuccess');

if (enrollmentForm) {
  enrollmentForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const submitBtn = enrollmentForm.querySelector('.form-submit');
    const originalText = submitBtn.innerText;
    
    // UI Loading State
    submitBtn.innerText = 'Registering...';
    submitBtn.disabled = true;

    try {
      // 1. Collect Form Data
      const formData = new FormData(enrollmentForm);
      
      // Handle multi-select checkboxes for time slots
      const timeSlots = formData.getAll('time_slots');
      
      const enrollmentData = {
        full_name: formData.get('full_name'),
        email: formData.get('email'),
        contact_number: `${formData.get('contact_code')} ${formData.get('contact')}`,
        whatsapp_number: `${formData.get('whatsapp_code')} ${formData.get('whatsapp')}`,
        country: formData.get('country'),
        profession: formData.get('profession'),
        company: formData.get('company'),
        qualification: formData.get('qualification'),
        batch_type: formData.get('batch_type'),
        time_slots: timeSlots // Array of strings
      };

      // 2. Request backend to register candidate directly
      const regRes = await fetch('/api/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ enrollmentData })
      });

      // Handle duplicate registration (409) with a specific user message
      if (regRes.status === 409) {
        const dupData = await regRes.json();
        submitBtn.innerText = originalText;
        submitBtn.disabled = false;
        alert(
          dupData.message ||
          'You have already registered for this batch. Please complete your payment or contact the IBSP team.'
        );
        return;
      }

      if (!regRes.ok) {
        const errData = await regRes.json();
        throw new Error(errData.error || 'Failed to complete registration.');
      }

      const regData = await regRes.json();

      // Select success modal elements
      const modal = document.getElementById('successModal');
      const modalMessage = document.getElementById('modalMessage');
      const modalOkBtn = document.getElementById('modalOkBtn');

      if (regData.emailSent) {
        modalMessage.innerHTML = `
          Thank you for registering for the Integrated Building Systems Professional (IBSP) Program.<br><br>
          Your registration has been completed successfully.<br><br>
          Our team will connect with you shortly via email or WhatsApp with the next steps.<br><br>
          A confirmation email has been sent to your registered email address.
        `;
      } else {
        modalMessage.innerHTML = `
          Your registration was successful.<br><br>
          Our team will contact you shortly.<br><br>
          If you do not receive an email within a few minutes, please contact support.
        `;
      }

      // Show success modal overlay
      modal.classList.add('active');

      // Listen to OK button click
      modalOkBtn.onclick = function () {
        modal.classList.remove('active');

        // Now transition page UI to success state
        enrollmentForm.style.display = 'none';
        formSuccess.style.display = 'block';

        const formContainer = document.querySelector('.pricing-form-container');
        if (formContainer) {
          const offsetTop = formContainer.offsetTop - 100;
          window.scrollTo({
            top: offsetTop,
            behavior: 'smooth'
          });
        }
      };
    } catch (err) {
      console.error('Submission error:', err);
      alert(err.message || 'There was an error submitting your form. Please try again or contact support.');
      submitBtn.innerText = originalText;
      submitBtn.disabled = false;
    }
  });
}


// ===== OUTCOMES SLIDER =====
const slides = document.querySelectorAll('.outcomes-slider-container .slide');
const dots = document.querySelectorAll('.outcomes-slider-container .dot');
const prevBtn = document.getElementById('prevSlide');
const nextBtn = document.getElementById('nextSlide');
let currentSlide = 0;
let slideInterval;

function initSlider() {
  if (slides.length === 0) return;
  startSlideTimer();
  
  // Event listeners for dots
  dots.forEach((dot, index) => {
    dot.addEventListener('click', () => {
      goToSlide(index);
      resetSlideTimer();
    });
  });

  // Event listeners for prev/next
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      const prevIndex = (currentSlide - 1 + slides.length) % slides.length;
      goToSlide(prevIndex);
      resetSlideTimer();
    });
  }
  
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      const nextIndex = (currentSlide + 1) % slides.length;
      goToSlide(nextIndex);
      resetSlideTimer();
    });
  }
}

function goToSlide(index) {
  slides[currentSlide].classList.remove('active');
  if(dots[currentSlide]) dots[currentSlide].classList.remove('active');
  
  currentSlide = index;
  
  slides[currentSlide].classList.add('active');
  if(dots[currentSlide]) dots[currentSlide].classList.add('active');
}

function startSlideTimer() {
  slideInterval = setInterval(() => {
    const nextIndex = (currentSlide + 1) % slides.length;
    goToSlide(nextIndex);
  }, 4000); // 4 seconds
}

function resetSlideTimer() {
  clearInterval(slideInterval);
  startSlideTimer();
}

window.addEventListener('DOMContentLoaded', initSlider);
